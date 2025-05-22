import express, { Request, Response } from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import * as TransactionDB from "./storage/transactiondb";

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
type Result<T> = { Ok: T } | { Err: null };

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

// In-memory cache to track TSS party receipts
type CachedTransaction = {
  tx: TransactionDB.Transaction;
  timestamp: number; // Unix timestamp in milliseconds
};
const txPartyMap: Map<string, Set<string>> = new Map(); // Map<txId, Set<partyId>>
const txCache: Map<string, CachedTransaction> = new Map(); // Map<txId, CachedTransaction>
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

app.post('/future-timestamp', (req: Request<{}, {}, Entry>, res: Response<{ timestamp: number }>) => {
  const {key, value} = req.body;
  const dbKey = 'future-timestamp' + key
  const dbValue = db.get(dbKey);
  // if value is already proposed, return it
  if (dbValue == null) {
    db.set(dbKey, value);
    res.json({timestamp: parseInt(value)});
    return
  }
  res.json({timestamp: parseInt(dbValue)});
});

// POST /transaction — store transaction receipt
app.post(
  "/transaction",
  async (
    req: Request<{}, {}, TransactionDB.Transaction & { party: string }>,
    res: Response<Result<{ txId: string }>>
  ) => {
    try {
      const {
        txId,
        sender,
        value,
        type,
        tssReceipt,
        originalTx,
        status,
        party,
      } = req.body;

      // Validate request data
      if (
        !txId ||
        !sender ||
        !value ||
        !type ||
        !tssReceipt ||
        !originalTx ||
        !status ||
        !party
      ) {
        return res.status(400).json({ Err: null });
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
            txId,
            sender,
            value,
            type,
            tssReceipt,
            originalTx,
            status,
          },
          timestamp: Date.now(),
        });
      }

      const receivedFrom = txPartyMap.get(txId)!;

      if (receivedFrom.size >= REQUIRED_CONFIRMATIONS) {
        // Save the transaction and clean up cache
        const { tx } = txCache.get(txId) as CachedTransaction;
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
      res.status(500).json({ Err: null });
    }
  }
);

// POST /transaction/status — update the status of a transaction
app.post(
  "/transaction/status",
  async (
    req: Request<{}, {}, { txId: string; status: string }>,
    res: Response<Result<null>>
  ) => {
    try {
      const { txId, status } = req.body;
      // Validate request data
      if (!txId || !status) {
        return res.status(400).json({ Err: null });
      }

      // Update transaction status
      await TransactionDB.updateTransactionStatus(txId, status);

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
      const { sender, txId, page } = req.query;
      let pageNum = 1;
      let txsPerPage = 10;
      let transactions: TransactionDB.Transaction[] = [];
      let totalTranactions = 0;
      let totalPages = 0;
      if (page) {
        pageNum = parseInt(page);
      }
      const pageStart = (pageNum - 1) * txsPerPage;
      if (txId) {
        const transaction = await TransactionDB.getTransactionById(txId);
        if (transaction) transactions.push(transaction);
        res.json({ Ok: { transactions } });
        return;
      } else if (sender) {
        totalTranactions = await TransactionDB.getTotalTransactionsBySender(
          sender
        );
        totalPages = Math.ceil(totalTranactions / txsPerPage);
        if (pageNum > totalPages) {
          return res.status(400).json({ Err: null });
        }
        transactions = await TransactionDB.getTransactionsBySender(
          sender,
          txsPerPage,
          pageStart
        );
      } else {
        totalTranactions = await TransactionDB.getTotalTransactions();
        totalPages = Math.ceil(totalTranactions / txsPerPage);
        if (pageNum > totalPages) {
          return res.status(400).json({ Err: null });
        }
        transactions = await TransactionDB.getTransactionsByPage(
          txsPerPage,
          pageStart
        );
      }
      res.json({ Ok: { transactions, totalTranactions, totalPages } });
    } catch (e) {
      console.error("Failed to fetch transactions for sender:", e);
      res.status(500).json({ Err: null });
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
