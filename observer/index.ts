import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import * as TransactionDB from "../shared/storage/transactiondb";
import { chainConfigsRaw, getChainConfigById } from "../shared/config";
import { isEthereumAddress, toEthereumAddress } from "../shared/utils/transformAddress";
import { isNormalizedTxId, normalizeTxId } from "../shared/utils/transformTxId";
import { initMonitorState, monitorState, saveMonitorState, setSyncReady, syncReady } from "./monitor/state";
import {
  EVMBridgeInGossipPayload,
  normalizeEVMBridgeInGossipPayload,
  verifyEVMBridgeInGossipPayload,
} from "../shared/utils/evmBridgeInGossip";
import {
  LiberdusBridgeInGossipPayload,
  normalizeLiberdusBridgeInGossipPayload,
  verifyLiberdusBridgeInGossipPayload,
} from "../shared/utils/liberdusBridgeInGossip";
import {
  monitorEthereumBridgeOutQueryFilter,
  monitorEthereumBridgeInQueryFilter,
  seedEthereumMonitorStateToLatest,
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

function parseBooleanOption(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function shouldSkipOldData(): boolean {
  return (
    parseBooleanOption(process.env.OBSERVER_SKIP_OLD_DATA) ||
    chainConfigsRaw.observerSkipOldData === true ||
    process.argv.includes("--skip-old-data")
  );
}

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
        failedTxScanBlocks: monitorState.failedTxScanBlocks,
        failedTxNonces: monitorState.failedTxNonces,
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

// ---------------------------------------------------------------------------
// Transactions API (compat with bridge UI coordinator endpoint)
// ---------------------------------------------------------------------------

const TX_PAGE_SIZE = 10;

function parseIntQuery(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

app.get(["/transaction", "/transactions"], (req, res) => {
  try {
    let txId = typeof req.query.txId === "string" ? req.query.txId.trim() : undefined;
    let sender = typeof req.query.sender === "string" ? req.query.sender.trim() : undefined;
    let type: TransactionDB.TransactionType | undefined;
    let status: TransactionDB.TransactionStatus | undefined;
    let page = parseIntQuery(req.query.page) ?? 1;

    if (
      typeof req.query.page === "string" &&
      (req.query.page.trim() === "" || !Number.isInteger(page) || page < 1)
    ) {
      return res.status(400).json({ Err: "Invalid page number" });
    }

    if (txId) {
      if (txId.length !== 64 && !(txId.startsWith("0x") && txId.length === 66)) {
        return res.status(400).json({ Err: "Invalid txId" });
      }
      txId = normalizeTxId(txId);
      if (!isNormalizedTxId(txId)) {
        return res.status(400).json({ Err: "Invalid txId" });
      }
    }

    if (sender !== undefined) {
      if (sender === "") {
        return res.status(400).json({ Err: "Invalid ethereum address format" });
      }
      sender = toEthereumAddress(sender);
      if (!isEthereumAddress(sender)) {
        return res.status(400).json({ Err: "Invalid ethereum address format" });
      }
    }

    if (req.query.type !== undefined) {
      if (typeof req.query.type !== "string" || req.query.type.trim() === "") {
        return res.status(400).json({ Err: "Invalid type" });
      }
      const parsedType = parseInt(req.query.type, 10);
      if (!TransactionDB.isTransactionType(parsedType)) {
        return res.status(400).json({ Err: "Invalid type" });
      }
      type = parsedType;
    }

    if (req.query.status !== undefined) {
      if (typeof req.query.status !== "string" || req.query.status.trim() === "") {
        return res.status(400).json({ Err: "Invalid status" });
      }
      const parsedStatus = parseInt(req.query.status, 10);
      if (!TransactionDB.isTransactionStatus(parsedStatus)) {
        return res.status(400).json({ Err: "Invalid status" });
      }
      status = parsedStatus;
    }

    if (txId) {
      const tx = TransactionDB.getTransactionById(txId);
      return res.json({
        Ok: {
          transactions: tx ? [tx] : [],
          totalTranactions: tx ? 1 : 0,
          totalPages: 1,
        },
      });
    }

    const options: Parameters<typeof TransactionDB.getTransactionsByPage>[2] = {};
    if (sender) options.sender = sender;
    if (type !== undefined) options.type = type;
    if (status !== undefined) options.status = status;

    const total = TransactionDB.getTotalTransactions(options);
    const totalPages = Math.max(1, Math.ceil(total / TX_PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * TX_PAGE_SIZE;

    const transactions = TransactionDB.getTransactionsByPage(
      TX_PAGE_SIZE,
      offset,
      options
    );

    return res.json({
      Ok: {
        transactions,
        totalTranactions: total,
        totalPages,
      },
    });
  } catch (e) {
    console.error("[observer] /transactions failed:", e);
    return res.status(500).json({ Err: "Failed to fetch transactions" });
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

app.post("/bridgein/evm/submitted", (req, res) => {
  try {
    const raw = req.body as Partial<EVMBridgeInGossipPayload> | undefined;
    if (!raw || typeof raw !== "object") {
      console.warn("[observer/gossip/evm] rejected payload: body missing or not an object");
      return res.status(400).json({ Err: "Invalid payload" });
    }

    let payload: EVMBridgeInGossipPayload;
    try {
      payload = normalizeEVMBridgeInGossipPayload({
        bridgeInTxId: `${raw.bridgeInTxId ?? ""}`,
        sourceChainId: Number(raw.sourceChainId),
        destinationChainId: Number(raw.destinationChainId),
        txHash: `${raw.txHash ?? ""}`,
        signedTx: `${raw.signedTx ?? ""}`,
        nonce: Number(raw.nonce),
        txTimestamp: Number(raw.txTimestamp),
        senderPartyIdx: Number(raw.senderPartyIdx),
      });
    } catch (error) {
      console.warn("[observer/gossip/evm] rejected payload: invalid encoding");
      return res.status(400).json({ Err: "Invalid payload encoding" });
    }

    const destinationChain = getChainConfigById(chainConfigsRaw, payload.destinationChainId);
    if (!destinationChain?.tssSenderAddress) {
      console.warn(
        `[observer/gossip/evm] rejected txId=${payload.bridgeInTxId}: unknown destinationChainId=${payload.destinationChainId}`
      );
      return res.status(400).json({ Err: "Unknown destinationChainId or missing tssSenderAddress" });
    }

    const verified = verifyEVMBridgeInGossipPayload(payload, destinationChain.tssSenderAddress);
    if (!verified.ok) {
      console.warn(
        `[observer/gossip/evm] rejected txId=${payload.bridgeInTxId}: verification failed (${verified.reason})`
      );
      return res.status(400).json({ Err: `Invalid bridgeIn gossip payload: ${verified.reason}` });
    }

    const existing = TransactionDB.getTransactionById(payload.bridgeInTxId);
    if (existing) {
      if (
        existing.status === TransactionDB.TransactionStatus.COMPLETED ||
        existing.status === TransactionDB.TransactionStatus.REVERTED
      ) {
        console.log(
          `[observer/gossip/evm] ignored finalized txId=${payload.bridgeInTxId} status=${existing.status}`
        );
        return res.json({ Ok: "ignored_finalized" });
      }
      const updateResult = TransactionDB.updateTransactionStatus(
        payload.bridgeInTxId,
        TransactionDB.TransactionStatus.SUBMITTED,
        payload.txHash,
        toEthereumAddress(destinationChain.tssSenderAddress),
        payload.nonce,
        null,
      );
      console.log(
        `[observer/gossip/evm] updated txId=${payload.bridgeInTxId} -> SUBMITTED result=${updateResult} sigVerified=true sourceChain=${payload.sourceChainId} destinationChain=${payload.destinationChainId} senderParty=${payload.senderPartyIdx}`
      );
      return res.json({ Ok: updateResult === "ok" ? "updated_submitted" : updateResult });
    }

    const txType = !chainConfigsRaw.enableLiberdusNetwork
      ? TransactionDB.TransactionType.BRIDGE_VAULT
      : TransactionDB.TransactionType.BRIDGE_IN;

    const tx: TransactionDB.Transaction = {
      txId: payload.bridgeInTxId,
      sender: "",
      value: "0x0",
      type: txType,
      txTimestamp: payload.txTimestamp,
      chainId: payload.sourceChainId,
      receiptId: payload.txHash,
      status: TransactionDB.TransactionStatus.SUBMITTED,
      tssSender: toEthereumAddress(destinationChain.tssSenderAddress),
      nonce: payload.nonce,
    };

    TransactionDB.saveTransaction(tx);
    console.log(
      `[observer/gossip/evm] saved txId=${payload.bridgeInTxId} as SUBMITTED sigVerified=true sourceChain=${payload.sourceChainId} destinationChain=${payload.destinationChainId} senderParty=${payload.senderPartyIdx}`
    );
    return res.json({ Ok: "saved_submitted" });
  } catch (error) {
    console.error("[observer] /bridgein/evm/submitted failed:", error);
    return res.status(500).json({ Err: "Failed to ingest bridgeIn submitted gossip" });
  }
});

app.post("/bridgein/liberdus/submitted", (req, res) => {
  try {
    const raw = req.body as Partial<LiberdusBridgeInGossipPayload> | undefined;
    if (!raw || typeof raw !== "object") {
      console.warn("[observer/gossip/liberdus] rejected payload: body missing or not an object");
      return res.status(400).json({ Err: "Invalid payload" });
    }

    let payload: LiberdusBridgeInGossipPayload;
    try {
      payload = normalizeLiberdusBridgeInGossipPayload({
        sourceTxId: `${raw.sourceTxId ?? ""}`,
        sourceChainId: Number(raw.sourceChainId),
        liberdusTxId: `${raw.liberdusTxId ?? ""}`,
        liberdusSignedTx: `${raw.liberdusSignedTx ?? ""}`,
        txTimestamp: Number(raw.txTimestamp),
        senderPartyIdx: Number(raw.senderPartyIdx),
      });
    } catch (_error) {
      console.warn("[observer/gossip/liberdus] rejected payload: invalid encoding");
      return res.status(400).json({ Err: "Invalid payload encoding" });
    }

    const sourceChain = getChainConfigById(chainConfigsRaw, payload.sourceChainId);
    if (!sourceChain?.tssSenderAddress) {
      console.warn(
        `[observer/gossip/liberdus] rejected sourceTxId=${payload.sourceTxId}: unknown sourceChainId=${payload.sourceChainId}`
      );
      return res.status(400).json({ Err: "Unknown sourceChainId or missing tssSenderAddress" });
    }

    const verified = verifyLiberdusBridgeInGossipPayload(payload, sourceChain.tssSenderAddress);
    if (!verified.ok) {
      console.warn(
        `[observer/gossip/liberdus] rejected sourceTxId=${payload.sourceTxId}: verification failed (${verified.reason})`
      );
      return res.status(400).json({ Err: `Invalid liberdus bridgeIn gossip payload: ${verified.reason}` });
    }

    const existing = TransactionDB.getTransactionById(payload.sourceTxId);
    if (existing) {
      if (
        existing.status === TransactionDB.TransactionStatus.COMPLETED ||
        existing.status === TransactionDB.TransactionStatus.REVERTED
      ) {
        console.log(
          `[observer/gossip/liberdus] ignored finalized sourceTxId=${payload.sourceTxId} status=${existing.status}`
        );
        return res.json({ Ok: "ignored_finalized" });
      }
      const updateResult = TransactionDB.updateTransactionStatus(
        payload.sourceTxId,
        TransactionDB.TransactionStatus.SUBMITTED,
        payload.liberdusTxId,
        toEthereumAddress(sourceChain.tssSenderAddress),
        payload.txTimestamp,
        null,
      );
      console.log(
        `[observer/gossip/liberdus] updated sourceTxId=${payload.sourceTxId} -> SUBMITTED result=${updateResult} sigVerified=true sourceChain=${payload.sourceChainId} senderParty=${payload.senderPartyIdx}`
      );
      return res.json({ Ok: updateResult === "ok" ? "updated_submitted" : updateResult });
    }

    const tx: TransactionDB.Transaction = {
      txId: payload.sourceTxId,
      sender: "",
      value: "0x0",
      type: TransactionDB.TransactionType.BRIDGE_OUT,
      txTimestamp: payload.txTimestamp,
      chainId: payload.sourceChainId,
      receiptId: payload.liberdusTxId,
      status: TransactionDB.TransactionStatus.SUBMITTED,
      tssSender: toEthereumAddress(sourceChain.tssSenderAddress),
      nonce: payload.txTimestamp,
    };
    TransactionDB.saveTransaction(tx);
    console.log(
      `[observer/gossip/liberdus] saved sourceTxId=${payload.sourceTxId} as SUBMITTED sigVerified=true sourceChain=${payload.sourceChainId} senderParty=${payload.senderPartyIdx}`
    );
    return res.json({ Ok: "saved_submitted" });
  } catch (error) {
    console.error("[observer] /bridgein/liberdus/submitted failed:", error);
    return res.status(500).json({ Err: "Failed to ingest liberdus bridgeIn submitted gossip" });
  }
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

    if (shouldSkipOldData()) {
      console.log("[observer] OBSERVER_SKIP_OLD_DATA enabled; seeding monitor cursors to latest data");
      await seedEthereumMonitorStateToLatest();
      monitorState.lastLiberdusTimestamp = Date.now();
      saveMonitorState();
      console.log(
        "[observer] Liberdus cursor seeded to:",
        new Date(monitorState.lastLiberdusTimestamp).toISOString()
      );
    }

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
    // monitorFailedBridgeIns is triggered automatically at the end of each BridgeIn scan.
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
