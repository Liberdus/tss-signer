import express, { Request, Response } from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import * as TransactionDB from "./storage/transactiondb";
import { isEthereumAddress } from "./utils/transformAddress";

// --- Types matching your Rust models ---
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

// --- A simple Result<T> type ---
type Result<T> = { Ok: T } | { Err: string | null };

// --- In-memory DB ---
const db = new Map<string, string>();

// Initialize signup entries at startup
const KEYGEN_KEY = "signup-keygen";
const SIGN_KEY = "signup-sign";
db.set(
  KEYGEN_KEY,
  JSON.stringify({ number: 0, uuid: uuidv4() } as PartySignup)
);
db.set(SIGN_KEY, JSON.stringify({ number: 0, uuid: uuidv4() } as PartySignup));

// Transaction data received from TSS
interface TxData
  extends Omit<
    TransactionDB.Transaction,
    "createdAt" | "updatedAt" | "reason"
  > {
  party: number;
}

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
// In-memory cache to track TSS party receipts
type CachedTransaction = {
  tx: TransactionDB.Transaction;
  timestamp: number; // Unix timestamp in milliseconds
  saved?: boolean; // Flag to indicate if transaction has been saved
};

type TxId = string;
type PartyId = number;

const txPartyMap: Map<TxId, Set<PartyId>> = new Map();
const txCache: Map<TxId, CachedTransaction> = new Map();
const THRESHOLD = 3;
const REQUIRED_CONFIRMATIONS = THRESHOLD + 1;
const CACHE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// --- Express app setup ---
const app = express();
app.use(
  cors({ origin: true, methods: ["GET", "POST", "PATCH"], credentials: true })
);

app.use(express.text({ type: "application/json" }));
app.use(express.json()); // Add standard JSON parser as well
app.use((req, res, next) => {
  if (req.body && typeof req.body === "string") {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {
      // Log but continue
      console.warn("Failed to parse JSON body", e);
    }
  }
  next();
});

// POST /get  — fetch an Entry by key
app.post(
  "/get",
  (req: Request<{}, {}, Index>, res: Response<Result<Entry>>) => {
    const { key } = req.body;
    const v = db.get(key);
    if (v !== undefined) {
      const entry: Entry = { key, value: v };
      res.json({ Ok: entry });
    } else {
      res.status(404).json({ Err: null });
    }
  }
);

// POST /set  — store an Entry
app.post("/set", (req: Request<{}, {}, Entry>, res: Response<Result<null>>) => {
  const { key, value } = req.body;
  db.set(key, value);
  res.json({ Ok: null });
});

// Helper to load params.json
async function loadParams(): Promise<Params> {
  const data = await fs.readFile(
    path.join(__dirname, "../../", "params.json"),
    "utf8"
  );
  return JSON.parse(data) as Params;
}

// POST /signupkeygen  — round-robin keygen signup
app.post("/signupkeygen", async (_req, res: Response<Result<PartySignup>>) => {
  try {
    const { parties } = await loadParams();
    const max = parseInt(parties, 10);

    console.log("Signup keygen request body:", _req.body);
    const key = _req.body;

    const raw = db.get(key)!;
    let current: PartySignup | null = null;
    try {
      current = JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse current signup: creating new one");
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

// POST /signupsign  — round-robin sign signup
app.post("/signupsign", async (_req, res: Response<Result<PartySignup>>) => {
  try {
    const { threshold, parties } = await loadParams();
    const max = parseInt(parties, 10);
    const key = _req.body;
    console.log("Signup sign request body:", _req.body);

    const raw = db.get(key)!;
    let current: PartySignup | null = null;
    try {
      current = JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse current signup: creating new one");
    }

    let next: PartySignup;
    if (current && current.number <= max) {
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

app.post(
  "/future-timestamp",
  (req: Request<{}, {}, Entry>, res: Response<{ timestamp: number }>) => {
    const { key, value } = req.body;
    const dbKey = "future-timestamp" + key;
    const dbValue = db.get(dbKey);
    // if value is already proposed, return it
    if (dbValue == null) {
      db.set(dbKey, value);
      res.json({ timestamp: parseInt(value) });
      return;
    }
    res.json({ timestamp: parseInt(dbValue) });
  }
);

// POST /transaction — store transaction receipt
app.post(
  "/transaction",
  async (
    req: Request<{}, {}, TxData>,
    res: Response<Result<{ txId: string }>>
  ) => {
    try {
      const {
        txId,
        sender,
        value,
        type,
        txTimestamp,
        receiptId,
        chainId,
        status,
        party,
      } = req.body;

      // Validate request data [TODO - add more validation]
      if (
        !txId ||
        !sender ||
        !isEthereumAddress(sender) ||
        !value ||
        !TransactionDB.isTransactionType(type) ||
        !txTimestamp ||
        receiptId !== "" ||
        !chainId || // [TODO] Add proper chainId validation
        !TransactionDB.isTransactionStatus(status) ||
        !party
      ) {
        console.log("Invalid Transaction Data:", req.body);
        return res.status(400).json({ Err: "Invalid transaction data" });
      }

      // Add sender to the tracking map
      if (!txPartyMap.has(txId)) {
        txPartyMap.set(txId, new Set());
      }
      txPartyMap.get(txId)!.add(party);

      // Cache the transaction data for later use
      if (!txCache.has(txId)) {
        txCache.set(txId, {
          tx: {
            txId: txId.toLowerCase(),
            sender: sender.toLowerCase(),
            value,
            type,
            txTimestamp,
            receiptId: receiptId.toLowerCase(),
            chainId,
            status,
          },
          timestamp: Date.now(),
          saved: false,
        });
      }

      const receivedFrom = txPartyMap.get(txId)!;

      if (receivedFrom.size >= REQUIRED_CONFIRMATIONS) {
        // Save the transaction and clean up cache
        let { tx, saved } = txCache.get(txId) as CachedTransaction;
        if (saved) {
          console.log(`Transaction ${txId} already saved, skipping.`);
          return res.status(202).json({ Ok: { txId } }); // Already saved
        }
        // Update saved to true to prevent race conditions
        txCache.get(txId)!.saved = true;
        console.log(`Saving transaction`, tx);
        await TransactionDB.saveTransaction(tx);
        console.log(
          `Transaction saved: ${txId}, type: ${type}, status: ${status}`
        );
        txPartyMap.delete(txId);
        txCache.delete(txId);

        return res.json({ Ok: { txId } });
      } else {
        console.log(
          `Transaction ${txId} received from ${receivedFrom.size}/${REQUIRED_CONFIRMATIONS} parties`
        );
        return res.status(202).json({
          Ok: {
            txId,
          },
        }); // Accepted, not yet stored
      }
    } catch (e) {
      console.error("Failed to save transaction:", e);
      res.status(500).json({ Err: "Failed to save transaction" });
    }
  }
);

// POST /transaction/status — update the status of a transaction
app.post(
  "/transaction/status",
  async (req: Request<{}, {}, TxStatusData>, res: Response<Result<null>>) => {
    try {
      const { txId, status, receiptId, reason, party } = req.body;
      // Validate request data [TODO - add more validation]
      if (
        !txId ||
        !TransactionDB.isTransactionStatus(status) ||
        !receiptId ||
        typeof reason !== "string" ||
        !party
      ) {
        console.error("Invalid transaction status data:", req.body);
        return res.status(400).json({ Err: "Invalid transaction status data" });
      }

      // If the transaction status is failed, console log the reason
      if (status === TransactionDB.TransactionStatus.FAILED) {
        console.log(
          `Transaction failed: ${txId}, party: ${party}, reason: ${reason}`
        );
      }

      // Update transaction status
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

type TransactionAPIQueryParameters = {
  sender?: string;
  type?: TransactionDB.TransactionType;
  status?: TransactionDB.TransactionStatus;
  txId?: string;
  page?: string;
};

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
      let { sender, txId, page, type, status } = req.query;
      let pageNum = 1;
      let txsPerPage = 10;
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
        const transaction = await TransactionDB.getTransactionById(txId);
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
        // Normalize to lowercase
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
      totalTranactions = await TransactionDB.getTotalTransactions({
        sender: sender,
        type,
        status,
      });
      totalPages = Math.ceil(totalTranactions / txsPerPage);
      if (pageNum > 1 && pageNum > totalPages) {
        return res.status(400).json({ Err: `Page ${pageNum} is out of range` });
      }
      if (totalTranactions === 0) {
        return res.json({
          Ok: { transactions, totalTranactions, totalPages: 0 },
        });
      }
      transactions = await TransactionDB.getTransactionsByPage(
        txsPerPage,
        pageStart,
        {
          sender,
          type,
          status,
        }
      );
      res.json({ Ok: { transactions, totalTranactions, totalPages } });
    } catch (e) {
      console.error("Failed to fetch transactions:", e);
      res.status(500).json({ Err: `Failed to fetch transactions ${e}` });
    }
  }
);
// Start the server
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8000;

// Initialize SQLite then start Express
(async () => {
  try {
    await TransactionDB.initializeTransactionsDatabase();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });

    setInterval(() => {
      const now = Date.now();
      for (const [txId, { timestamp }] of txCache.entries()) {
        if (now - timestamp > CACHE_TIMEOUT_MS) {
          txCache.delete(txId);
          txPartyMap.delete(txId);
          console.log(`Cleaned up stale transaction: ${txId}`);
        }
      }
    }, 60 * 1000); // Runs every 60 seconds
  } catch (err) {
    console.error("Failed to initialize the application:", err);
    process.exit(1);
  }
})();
