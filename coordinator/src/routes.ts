import express, { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import * as TransactionDB from "./storage/transactiondb";
import { isEthereumAddress } from "./utils/transformAddress";
import { isNormalizedTxId, normalizeTxId } from "./utils/transformTxId";
import { verifyTxOnChain } from "./verification";
import { monitorEthereumBridgeOutQueryFilter } from "./monitor/ethereum";
import { getChainConfigById } from "./config";
import { syncReady, monitorState } from "./monitor/state";
import { verifySignedCoordinatorRequest } from "./auth";

// --- Types ---
interface Entry {
  key: string;
  value: string;
}
interface Index {
  key: string;
}
interface PartySignup {
  number: number;
  uuid: string;
}
interface Params {
  parties: string;
  threshold: string;
}

type Result<T> = { Ok: T } | { Err: string | null };

interface TxStatusData
  extends Omit<
    TransactionDB.Transaction,
    | "sender"
    | "value"
    | "type"
    | "txTimestamp"
    | "chainId"
    | "createdAt"
    | "updatedAt"
  > {
  party: number;
}

type TransactionAPIQueryParameters = {
  sender?: string;
  type?: TransactionDB.TransactionType;
  status?: TransactionDB.TransactionStatus;
  txId?: string;
  page?: string;
  unprocessed?: string; // when "true", returns PENDING + PROCESSING ordered by txTimestamp ASC
};

// --- Helpers ---
// Cached params — read once from disk on first use, reused on all subsequent calls.
let _paramsCache: Promise<Params> | null = null;
function loadParams(): Promise<Params> {
  if (!_paramsCache) {
    _paramsCache = fs
      .readFile(path.join(__dirname, "../../", "params.json"), "utf8")
      .then((data) => JSON.parse(data) as Params);
  }
  return _paramsCache;
}

// --- In-memory KV store (used by keygen/sign round relay and future-timestamp) ---
const db = new Map<string, string>();
db.set("signup-keygen", JSON.stringify({ number: 0, uuid: uuidv4() }));
db.set("signup-sign", JSON.stringify({ number: 0, uuid: uuidv4() }));

export function registerRoutes(app: express.Application): void {
  // GET /status — always available; reports whether the coordinator has
  // finished its initial ordered sync (BridgedOut → Liberdus → BridgedIn).
  app.get("/status", (_req, res) => {
    res.json({ syncReady });
  });

  // GET /health — always available; detailed coordinator health snapshot.
  app.get("/health", async (_req, res) => {
    try {
      const { pending, processing, completed, failed, reverted } =
        await TransactionDB.getTransactionCountsByStatus();

      const mem = process.memoryUsage();

      res.json({
        status: syncReady ? "ready" : "syncing",
        uptime: Math.floor(process.uptime()),
        monitorState: {
          blocks: monitorState.blocks,
          vault: monitorState.vault,
          bridgeInBlocks: monitorState.bridgeInBlocks,
          lastLiberdusTimestamp: new Date(monitorState.lastLiberdusTimestamp).toISOString(),
        },
        transactions: { pending, processing, completed, failed, reverted },
        memory: {
          heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(1),
          rssMB: +(mem.rss / 1024 / 1024).toFixed(1),
        },
      });
    } catch (e) {
      res.status(500).json({ Err: "Failed to collect health data" });
    }
  });

  // Block all other routes while the initial sync is in progress.
  // TSS parties receive a 503 and should skip/retry rather than proceeding.
  app.use((_req, res, next) => {
    if (!syncReady) {
      res.status(503).json({ Err: "Coordinator is syncing — please retry shortly" });
      return;
    }
    next();
  });

  // POST /get — fetch an Entry by key
  app.post(
    "/get",
    verifySignedCoordinatorRequest,
    (req: Request<{}, {}, Index>, res: Response<Result<Entry>>) => {
      // console.log("get:", req.body);
      const { key } = req.body;
      const v = db.get(key);
      if (v !== undefined) {
        res.json({ Ok: { key, value: v } });
      } else {
        res.status(404).json({ Err: null });
      }
    }
  );

  // POST /set — store an Entry
  app.post(
    "/set",
    verifySignedCoordinatorRequest,
    (req: Request<{}, {}, Entry>, res: Response<Result<null>>) => {
      // console.log("set:", req.body);
      const { key, value } = req.body;
      db.set(key, value);
      res.json({ Ok: null });
    }
  );

  // POST /signupkeygen — round-robin keygen signup
  app.post("/signupkeygen", verifySignedCoordinatorRequest, async (_req: Request, res: Response<Result<PartySignup>>) => {
    try {
      const { parties } = await loadParams();
      const max = parseInt(parties, 10);

      console.log("Signup keygen request body:", _req.body);
      const key = _req.body;

      const raw = db.get(key);
      let current: PartySignup | null = null;
      if (raw !== undefined) {
        try {
          current = JSON.parse(raw);
        } catch (e) {
          console.error("Failed to parse current signup for key:", key, "— creating new one");
        }
      } else {
        console.log("signup-keygen: creating new one");
      }

      let next: PartySignup;
      if (current && current.number < max) {
        next = { number: current.number + 1, uuid: current.uuid };
      } else {
        next = { number: 1, uuid: uuidv4() };
      }

      db.set(key, JSON.stringify(next));
      console.log("signup-keygen →", key, JSON.stringify(next));
      res.json({ Ok: next });
    } catch (e) {
      console.error(e);
      res.status(404).json({ Err: null });
    }
  });

  // POST /signupsign — round-robin sign signup
  app.post("/signupsign", verifySignedCoordinatorRequest, async (_req: Request, res: Response<Result<PartySignup>>) => {
    try {
      const { parties } = await loadParams();
      const max = parseInt(parties, 10);
      const key = _req.body;
      console.log("Signup sign request body:", _req.body);

      const raw = db.get(key);
      let current: PartySignup | null = null;
      if (raw !== undefined) {
        try {
          current = JSON.parse(raw);
        } catch (e) {
          console.error("Failed to parse current signup for key:", key, "— creating new one");
        }
      } else {
        console.log("signup-sign: creating new one");
      }

      let next: PartySignup;
      if (current && current.number < max) {
        next = { number: current.number + 1, uuid: current.uuid };
      } else {
        next = { number: 1, uuid: uuidv4() };
      }

      db.set(key, JSON.stringify(next));
      console.log("signup-sign →", key, JSON.stringify(next));
      res.json({ Ok: next });
    } catch (e) {
      console.error(e);
      res.status(404).json({ Err: null });
    }
  });

  // POST /future-timestamp — first-write-wins timestamp agreement
  app.post(
    "/future-timestamp",
    verifySignedCoordinatorRequest,
    (req: Request<{}, {}, Entry>, res: Response<{ timestamp: number }>) => {
      const { key, value } = req.body;
      const dbKey = "future-timestamp" + key;
      const dbValue = db.get(dbKey);
      if (dbValue == null) {
        db.set(dbKey, value);
        res.json({ timestamp: parseInt(value) });
        return;
      }
      res.json({ timestamp: parseInt(dbValue) });
    }
  );

  // POST /transaction/status — update the status of a transaction
  app.post(
    "/transaction/status",
    verifySignedCoordinatorRequest,
    async (req: Request<{}, {}, TxStatusData>, res: Response<Result<null>>) => {
      try {
        const { txId, status, receiptId, reason, party } = req.body;
        const isTerminalWithReceipt =
          status === TransactionDB.TransactionStatus.COMPLETED ||
          status === TransactionDB.TransactionStatus.REVERTED;
        const hasValidReceiptId = isTerminalWithReceipt
          ? isNormalizedTxId(receiptId)
          : receiptId === "" || isNormalizedTxId(receiptId);

        if (
          !isNormalizedTxId(txId) ||
          !TransactionDB.isTransactionStatus(status) ||
          !hasValidReceiptId ||
          typeof reason !== "string" ||
          !party
        ) {
          console.error("Invalid transaction status data:", req.body);
          return res
            .status(400)
            .json({ Err: "Invalid transaction status data" });
        }

        if (
          status === TransactionDB.TransactionStatus.PENDING ||
          status === TransactionDB.TransactionStatus.PROCESSING
        ) {
          console.error(
            `No need to report for pending or processing transactions: ${txId}, party: ${party}, status: ${status}`,
          );
          return res.status(404).json({
            Err: "No need to report for pending or processing transactions",
          });
        }

        if (status === TransactionDB.TransactionStatus.FAILED) {
          console.log(
            `Transaction failed: ${txId}, party: ${party}, reason: ${reason}`,
          );
        }

        if (status === TransactionDB.TransactionStatus.REVERTED) {
          console.log(
            `Transaction reverted on-chain: ${txId}, party: ${party}`,
          );
        }

        const current = await TransactionDB.getTransactionById(txId);
        if (!current) {
          console.error(
            `Transaction ${txId} not found in DB for status update`,
          );
          return res.status(404).json({ Err: "Transaction not found" });
        }

        // If the transaction has the same status, txId, and receiptId, ignore
        if (
          current.status === status &&
          current.txId === txId &&
          current.receiptId === receiptId
        ) {
          console.log(
            "Ignoring duplicate status update:",
            txId,
            status,
            receiptId,
          );
          return res.json({ Ok: null });
        }

        // Do not overwrite COMPLETED or REVERTED with FAILED, and do not overwrite COMPLETED with REVERTED
        if (
          current?.status === TransactionDB.TransactionStatus.COMPLETED &&
          (status === TransactionDB.TransactionStatus.FAILED || status === TransactionDB.TransactionStatus.REVERTED)
        ) {
          console.log(
            `Ignoring ${status === TransactionDB.TransactionStatus.FAILED ? 'FAILED' : 'REVERTED'} status update; transaction already COMPLETED:`,
            txId
          );
          return res.json({ Ok: null });
        }

        if (
          current?.status === TransactionDB.TransactionStatus.REVERTED &&
          status === TransactionDB.TransactionStatus.FAILED
        ) {
          console.log(
            "Ignoring FAILED status update; transaction already REVERTED:",
            txId
          );
          return res.json({ Ok: null });
        }

        // For COMPLETED or REVERTED: verify the transaction on-chain before persisting
        if (
          status === TransactionDB.TransactionStatus.COMPLETED ||
          status === TransactionDB.TransactionStatus.REVERTED
        ) {
          const verified = await verifyTxOnChain(
            current.type,
            current.chainId,
            receiptId,
            txId,
            status === TransactionDB.TransactionStatus.REVERTED,
          );
          if (!verified) {
            console.error(
              `On-chain verification not found for ${txId} (receiptId: ${receiptId})`
            );
            return res
              .status(400)
              .json({ Err: "On-chain verification not found!" });
          }
          console.log(`On-chain verification passed for ${txId}`);
        }

        await TransactionDB.updateTransactionStatus(
          txId,
          status,
          receiptId,
          reason
        );
        console.log(`Transaction status updated: ${txId}, status: ${status}`);
        res.json({ Ok: null });
      } catch (e) {
        console.error("Failed to update transaction status:", e);
        res.status(500).json({ Err: null });
      }
    }
  );

  // GET /transaction — paginated query with optional filters
  app.get(
    "/transaction",
    async (
      req: Request<{}, {}, {}, TransactionAPIQueryParameters>,
      res: Response<
        Result<{
          transactions: TransactionDB.Transaction[];
          totalPages?: number;
          totalTranactions?: number;
        }>
      >
    ) => {
      try {
        let { sender, txId, page, type, status, unprocessed } = req.query;
        let pageNum = 1;
        const txsPerPage = 10;
        let transactions: TransactionDB.Transaction[] = [];
        let totalTranactions = 0;
        let totalPages = 0;

        if (page) {
          pageNum = parseInt(page);
          if (isNaN(parseInt(page)) || parseInt(page) < 1) {
            return res.status(400).json({ Err: "Invalid page number" });
          }
        }
        const pageStart = (pageNum - 1) * txsPerPage;

        if (txId) {
          if (
            txId.length !== 64 &&
            !(txId.startsWith("0x") && txId.length === 66)
          ) {
            res.status(400).json({ Err: "Invalid txId" });
            return;
          }
          const transaction = await TransactionDB.getTransactionById(normalizeTxId(txId));
          if (transaction) transactions.push(transaction);
          res.json({
            Ok: {
              transactions,
              totalTranactions: transactions.length,
              totalPages: transactions.length,
            },
          });
          return;
        }

        if (sender) {
          if (!isEthereumAddress(sender)) {
            return res
              .status(400)
              .json({ Err: "Invalid ethereum address format" });
          }
          sender = sender.toLowerCase();
        }

        if (type !== undefined) {
          const parsedType = parseInt(type as unknown as string);
          if (!TransactionDB.isTransactionType(parsedType)) {
            return res.status(400).json({ Err: "Invalid type" });
          }
          type = parsedType;
        }

        if (status !== undefined) {
          const parsedStatus = parseInt(status as unknown as string);
          if (!TransactionDB.isTransactionStatus(parsedStatus)) {
            return res.status(400).json({ Err: "Invalid status" });
          }
          status = parsedStatus;
        }

        const isUnprocessed = unprocessed === "true";

        // While the initial ordered scan (BridgedOut → Liberdus → BridgedIn) has
        // not yet completed, return empty for pending/unprocessed queries.
        // This prevents TSS parties from picking up transactions that are already
        // completed on-chain but whose BridgedIn events haven't been scanned yet.
        if (
          !syncReady &&
          (isUnprocessed || status === TransactionDB.TransactionStatus.PENDING)
        ) {
          return res.json({ Ok: { transactions: [], totalTranactions: 0, totalPages: 0 } });
        }

        totalTranactions = await TransactionDB.getTotalTransactions({
          sender,
          type,
          status,
          unprocessed: isUnprocessed,
        });
        totalPages = Math.ceil(totalTranactions / txsPerPage);

        if (pageNum > 1 && pageNum > totalPages) {
          return res
            .status(400)
            .json({ Err: `Page ${pageNum} is out of range` });
        }
        if (totalTranactions === 0) {
          return res.json({
            Ok: { transactions, totalTranactions, totalPages: 0 },
          });
        }

        transactions = await TransactionDB.getTransactionsByPage(
          txsPerPage,
          pageStart,
          { sender, type, status, unprocessed: isUnprocessed }
        );
        res.json({ Ok: { transactions, totalTranactions, totalPages } });
      } catch (e) {
        console.error("Failed to fetch transactions:", e);
        res.status(500).json({ Err: `Failed to fetch transactions ${e}` });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // POST /notify-bridgeout — triggered by UI/clients when a BridgeOut event
  // is observed on-chain, prompting an immediate queryFilter poll instead of
  // waiting for the next scheduled interval (up to 1 min in production).
  //
  // Per-chain throttle + fixed deferred trigger strategy:
  //   • If cooldown (5s) has elapsed since last poll → poll immediately.
  //   • If within cooldown → schedule exactly one deferred poll for
  //     Date.now() + COOLDOWN_MS (full 5s from this notification's arrival),
  //     so late-arriving events are never silently dropped.
  //   • Subsequent calls while a deferred timer is already pending → no-op.
  //
  // Example timeline (COOLDOWN_MS = 5s):
  //   t= 0s  notify → immediate poll,    lastPoll=0s
  //   t= 2s  notify → timer set t=7s
  //   t= 3s  notify → no-op (timer pending)
  //   t= 7s  timer fires → poll,         lastPoll=7s, cooldown clears at t=12s
  //   t= 8s  notify → timer set t=13s
  //   t=13s  timer fires → poll,         lastPoll=13s
  // ---------------------------------------------------------------------------

  const NOTIFY_COOLDOWN_MS = 5_000;

  // Per-chain timestamp of the most recent triggered poll (immediate or deferred).
  const notifyLastPollAt = new Map<number, number>();

  // Per-chain handle for a scheduled deferred poll. At most one per chain at
  // any time — prevents a burst of notifications from queuing multiple polls.
  const notifyPendingTimer = new Map<number, NodeJS.Timeout>();

  app.post("/notify-bridgeout", (req, res) => {
    const { chainId } = req.body;

    // Validate that chainId is a number belonging to a configured chain.
    if (typeof chainId !== "number" || !getChainConfigById(chainId)) {
      return res.status(400).json({ Err: "Invalid or unknown chainId" });
    }

    const now = Date.now();
    const lastPoll = notifyLastPollAt.get(chainId) ?? 0;
    const elapsed = now - lastPoll;

    console.log(
      `[notify-bridgeout] ${chainId} lastPoll=${lastPoll} ${elapsed / 1000}s ${elapsed >= NOTIFY_COOLDOWN_MS ? "immediate" : "deferred"} `
    );

    if (elapsed >= NOTIFY_COOLDOWN_MS) {
      // Cooldown has passed — trigger an immediate poll.
      // Cancel any deferred timer for this chain; the immediate poll supersedes it.
      const existing = notifyPendingTimer.get(chainId);
      if (existing) {
        clearTimeout(existing);
        notifyPendingTimer.delete(chainId);
      }

      notifyLastPollAt.set(chainId, now);

      // Fire-and-forget: only scan the notified chain.
      // Per-chain lock in monitorEthereumBridgeOutQueryFilter safely
      // skips this chain if a scan is already in progress for it.
      monitorEthereumBridgeOutQueryFilter(chainId).catch((err) => {
        console.error(`[notify-bridgeout] Poll error for chain ${chainId}:`, err);
      });

      return res.json({ Ok: "triggered" });
    }

    // Within cooldown — schedule exactly one deferred poll if not already pending.
    // The timer is set to fire COOLDOWN_MS from now (not from lastPoll), so the
    // poll always runs at least 5s after the notification that scheduled it.
    if (!notifyPendingTimer.has(chainId)) {
      const t = setTimeout(() => {
        notifyPendingTimer.delete(chainId);
        notifyLastPollAt.set(chainId, Date.now());

        monitorEthereumBridgeOutQueryFilter(chainId).catch((err) => {
          console.error(
            `[notify-bridgeout] Deferred poll error for chain ${chainId}:`,
            err
          );
        });
      }, NOTIFY_COOLDOWN_MS);

      notifyPendingTimer.set(chainId, t);
      return res.json({ Ok: "queued" });
    }

    // A deferred timer is already scheduled — nothing more to do.
    return res.json({ Ok: "cooldown" });
  });
}
