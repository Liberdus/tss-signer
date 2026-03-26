import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import * as TransactionDB from "../shared/storage/transactiondb";
import { chainConfigsRaw, getChainConfigById } from "../shared/config";
import { initMonitorState, monitorState, setSyncReady, syncReady } from "./monitor/state";
import {
  monitorEthereumBridgeOutQueryFilter,
  monitorEthereumBridgeInQueryFilter,
} from "./monitor/ethereum";
import { monitorLiberdusTransactions } from "./monitor/liberdus";
import { startDriftResistantScheduler } from "../shared/utils/scheduler";

// ---------------------------------------------------------------------------
// Timestamped console logs
// ---------------------------------------------------------------------------

;(function enableTimestampedConsoleLogs() {
  const methods: Array<"log" | "info" | "warn" | "error"> = ["log", "info", "warn", "error"];
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: any[]) => {
      original(`[${new Date().toISOString()}]`, ...args);
    };
  }
})();

// ---------------------------------------------------------------------------
// Party index and derived paths
// ---------------------------------------------------------------------------

const PARTY_INDEX = parseInt(process.env.PARTY_INDEX ?? "1", 10);
if (isNaN(PARTY_INDEX) || PARTY_INDEX < 1 || PARTY_INDEX > 99) {
  console.error("[observer] PARTY_INDEX env must be a number between 1 and 99");
  process.exit(1);
}

const DB_DIR = path.resolve(process.cwd(), "db");
const DB_PATH = path.join(DB_DIR, `transactions-${PARTY_INDEX}.sqlite`);
const STATE_PATH = path.join(DB_DIR, `block_state-${PARTY_INDEX}.json`);
const PORT = 8100 + PARTY_INDEX;

fs.mkdirSync(DB_DIR, { recursive: true });

console.log(`[observer] Party index: ${PARTY_INDEX}`);
console.log(`[observer] DB path:     ${DB_PATH}`);
console.log(`[observer] State path:  ${STATE_PATH}`);
console.log(`[observer] HTTP port:   ${PORT}`);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ETH_MONITOR_INTERVAL_MS = 60 * 1000;
const LIB_MONITOR_INTERVAL_MS = 10_000;
const INITIAL_SYNC_RETRY_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// /notify-bridgeout state
// ---------------------------------------------------------------------------

const NOTIFY_COOLDOWN_MS = 15_000;
const notifyLastPollAt = new Map<number, number>();
const notifyPendingTimer = new Map<number, NodeJS.Timeout>();

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.use(cors({ origin: true, methods: ["GET", "POST"], credentials: true }));
app.use(express.json());

app.get("/status", (_req, res) => {
  res.json({ syncReady });
});

app.get("/health", (_req, res) => {
  try {
    const counts = TransactionDB.getTransactionCountsByStatus();
    const mem = process.memoryUsage();
    res.json({
      status: syncReady ? "ready" : "syncing",
      partyIndex: PARTY_INDEX,
      uptime: Math.floor(process.uptime()),
      monitorState: {
        blocks: monitorState.blocks,
        vault: monitorState.vault,
        bridgeInBlocks: monitorState.bridgeInBlocks,
        revertScanBlocks: monitorState.revertScanBlocks,
        revertedNonces: monitorState.revertedNonces,
        lastLiberdusTimestamp: new Date(monitorState.lastLiberdusTimestamp).toISOString(),
      },
      transactions: counts,
      memory: {
        heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(1),
        rssMB: +(mem.rss / 1024 / 1024).toFixed(1),
      },
    });
  } catch (e) {
    res.status(500).json({ Err: "Failed to collect health data" });
  }
});

app.post("/notify-bridgeout", (req, res) => {
  const { chainId } = req.body;

  if (typeof chainId !== "number" || !getChainConfigById(chainConfigsRaw, chainId)) {
    return res.status(400).json({ Err: "Invalid or unknown chainId" });
  }

  const now = Date.now();
  const lastPoll = notifyLastPollAt.get(chainId) ?? 0;
  const elapsed = now - lastPoll;

  console.log(
    `[notify-bridgeout] chainId=${chainId} elapsed=${(elapsed / 1000).toFixed(1)}s ${
      elapsed >= NOTIFY_COOLDOWN_MS ? "immediate" : "deferred"
    }`
  );

  if (elapsed >= NOTIFY_COOLDOWN_MS) {
    const existing = notifyPendingTimer.get(chainId);
    if (existing) {
      clearTimeout(existing);
      notifyPendingTimer.delete(chainId);
    }
    notifyLastPollAt.set(chainId, now);
    monitorEthereumBridgeOutQueryFilter(chainId).catch((err) => {
      console.error(`[notify-bridgeout] Poll error for chain ${chainId}:`, err);
    });
    return res.json({ Ok: "triggered" });
  }

  if (!notifyPendingTimer.has(chainId)) {
    const t = setTimeout(() => {
      notifyPendingTimer.delete(chainId);
      notifyLastPollAt.set(chainId, Date.now());
      monitorEthereumBridgeOutQueryFilter(chainId).catch((err) => {
        console.error(`[notify-bridgeout] Deferred poll error for chain ${chainId}:`, err);
      });
    }, NOTIFY_COOLDOWN_MS);
    notifyPendingTimer.set(chainId, t);
    return res.json({ Ok: "queued" });
  }

  return res.json({ Ok: "cooldown" });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

(async () => {
  try {
    TransactionDB.initializeTransactionsDatabase(DB_PATH);
    console.log("[observer] Database initialized");

    initMonitorState(STATE_PATH);
    console.log(
      "[observer] Monitor state loaded. Last Liberdus timestamp:",
      new Date(monitorState.lastLiberdusTimestamp).toISOString()
    );

    // Bind HTTP port before sync so tss-party gets syncReady:false instead of ECONNREFUSED
    app.listen(PORT, () => {
      console.log(`[observer] HTTP server running on port ${PORT} (initial sync in progress)`);
    });

    // ---------------------------------------------------------------------------
    // Initial ordered sync: BridgedOut → Liberdus → BridgedIn
    //
    // BridgedIn runs last so source records exist before completion scan, minimising
    // early-saves. syncReady is set only after all three complete.
    // ---------------------------------------------------------------------------
    console.log("[observer] Initial sync: scanning BridgedOut events...");
    while (!(await monitorEthereumBridgeOutQueryFilter(undefined, true))) {
      console.warn(
        `[observer] Initial BridgedOut sync incomplete, retrying in ${INITIAL_SYNC_RETRY_DELAY_MS}ms...`
      );
      await new Promise((r) => setTimeout(r, INITIAL_SYNC_RETRY_DELAY_MS));
    }

    if (chainConfigsRaw.enableLiberdusNetwork) {
      console.log("[observer] Initial sync: scanning Liberdus transactions...");
      await monitorLiberdusTransactions();
    }

    console.log("[observer] Initial sync: scanning BridgedIn events...");
    while (!(await monitorEthereumBridgeInQueryFilter(undefined, true))) {
      console.warn(
        `[observer] Initial BridgedIn sync incomplete, retrying in ${INITIAL_SYNC_RETRY_DELAY_MS}ms...`
      );
      await new Promise((r) => setTimeout(r, INITIAL_SYNC_RETRY_DELAY_MS));
    }

    setSyncReady();
    console.log("[observer] Initial sync complete — syncReady=true");

    // Periodic schedulers: BridgedOut and BridgedIn always run as a sequential pair.
    // monitorRevertedBridgeIns is triggered automatically at the end of each BridgeIn scan.
    startDriftResistantScheduler(async () => {
      await monitorEthereumBridgeOutQueryFilter();
      await monitorEthereumBridgeInQueryFilter();
    }, ETH_MONITOR_INTERVAL_MS);

    if (chainConfigsRaw.enableLiberdusNetwork) {
      startDriftResistantScheduler(monitorLiberdusTransactions, LIB_MONITOR_INTERVAL_MS);
    }
  } catch (err) {
    console.error("[observer] Failed to initialize:", err);
    process.exit(1);
  }
})();
