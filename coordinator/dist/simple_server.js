"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const uuid_1 = require("uuid");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const TransactionDB = __importStar(require("./storage/transactiondb"));
// --- In-memory DB ---
const db = new Map();
// Initialize signup entries at startup
const KEYGEN_KEY = "signup-keygen";
const SIGN_KEY = "signup-sign";
db.set(KEYGEN_KEY, JSON.stringify({ number: 0, uuid: (0, uuid_1.v4)() }));
db.set(SIGN_KEY, JSON.stringify({ number: 0, uuid: (0, uuid_1.v4)() }));
// --- Express app setup ---
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: true, methods: ["GET", "POST", "PATCH"], credentials: true }));
app.use(express_1.default.text({ type: "application/json" }));
app.use(express_1.default.json()); // Add standard JSON parser as well
app.use((req, res, next) => {
    if (req.body && typeof req.body === "string") {
        try {
            req.body = JSON.parse(req.body);
        }
        catch (e) {
            // Log but continue
            console.warn("Failed to parse JSON body", e);
        }
    }
    next();
});
// POST /get  — fetch an Entry by key
app.post("/get", (req, res) => {
    const { key } = req.body;
    const v = db.get(key);
    if (v !== undefined) {
        const entry = { key, value: v };
        res.json({ Ok: entry });
    }
    else {
        res.status(404).json({ Err: null });
    }
});
// POST /set  — store an Entry
app.post("/set", (req, res) => {
    const { key, value } = req.body;
    db.set(key, value);
    res.json({ Ok: null });
});
// Helper to load params.json
async function loadParams() {
    const data = await promises_1.default.readFile(path_1.default.join(__dirname, "../../", "params.json"), "utf8");
    return JSON.parse(data);
}
// POST /signupkeygen  — round-robin keygen signup
app.post("/signupkeygen", async (_req, res) => {
    try {
        const { parties } = await loadParams();
        const max = parseInt(parties, 10);
        console.log("Signup keygen request body:", _req.body);
        const key = _req.body;
        const raw = db.get(key);
        let current = null;
        try {
            current = JSON.parse(raw);
        }
        catch (e) {
            console.error("Failed to parse current signup: creating new one");
        }
        let next;
        if (current && current.number < max) {
            next = { number: current.number + 1, uuid: current.uuid };
        }
        else {
            next = { number: 1, uuid: (0, uuid_1.v4)() };
        }
        db.set(key, JSON.stringify(next));
        console.log("signup-keygen →", key, JSON.stringify(next));
        res.json({ Ok: next });
    }
    catch (e) {
        console.error(e);
        res.status(404).json({ Err: null });
    }
});
// POST /signupsign  — round-robin sign signup
app.post("/signupsign", async (_req, res) => {
    try {
        const { threshold } = await loadParams();
        const max = parseInt(threshold, 10) + 1;
        const key = _req.body;
        console.log("Signup sign request body:", _req.body);
        const raw = db.get(key);
        let current = null;
        try {
            current = JSON.parse(raw);
        }
        catch (e) {
            console.error("Failed to parse current signup: creating new one");
        }
        let next;
        if (current && current.number < max) {
            next = { number: current.number + 1, uuid: current.uuid };
        }
        else {
            next = { number: 1, uuid: (0, uuid_1.v4)() };
        }
        db.set(key, JSON.stringify(next));
        console.log("signup-sign →", key, JSON.stringify(next));
        res.json({ Ok: next });
    }
    catch (e) {
        console.error(e);
        res.status(404).json({ Err: null });
    }
});
// POST /transaction — store transaction receipt
app.post("/transaction", async (req, res) => {
    try {
        const { txId, sender, value, type, tssReceipt, originalTx, status } = req.body;
        // Validate request data
        if (!txId ||
            !sender ||
            !value ||
            !type ||
            !tssReceipt ||
            !originalTx ||
            !status) {
            return res.status(400).json({ Err: null });
        }
        await TransactionDB.saveTransaction({
            tssReceipt,
            originalTx,
            sender,
            value,
            txId,
            type,
            status,
        });
        console.log(`Transaction saved: ${txId}, type: ${type}, status: ${status}`);
        res.json({ Ok: { txId } });
    }
    catch (e) {
        console.error("Failed to save transaction:", e);
        res.status(500).json({ Err: null });
    }
});
// GET /transactions — retrieve transactions (optional)
app.get("/transactions", async (_req, res) => {
    try {
        const transactions = await TransactionDB.getAllTransactions();
        console.log("Transactions fetched:", transactions.length);
        res.json({ Ok: transactions });
    }
    catch (e) {
        console.error("Failed to fetch transactions:", e);
        res.status(500).json({ Err: null });
    }
});
// GET /transaction/:txId — retrieve transaction by txId
app.get("/transaction/:txId", async (req, res) => {
    try {
        const { txId } = req.params;
        if (!txId) {
            return res.status(400).json({ Err: null });
        }
        const transaction = await TransactionDB.getTransactionById(txId);
        if (transaction) {
            res.json({ Ok: transaction });
        }
        else {
            res.status(404).json({ Err: null });
        }
    }
    catch (e) {
        console.error("Failed to fetch transaction:", e);
        res.status(500).json({ Err: null });
    }
});
// POST /transactions/:txId/status — update the status of a transaction
app.post("/transaction/:txId/status", async (req, res) => {
    try {
        const { txId } = req.params;
        const { status } = req.body;
        // Validate request data
        if (!txId || !status) {
            return res.status(400).json({ Err: null });
        }
        // Update transaction status
        await TransactionDB.updateTransactionStatus(txId, status);
        console.log(`Transaction status updated: ${txId}, status: ${status}`);
        res.json({ Ok: null });
    }
    catch (e) {
        console.error("Failed to update transaction status:", e);
        res.status(500).json({ Err: null });
    }
});
// GET /transactions/:sender — retrieve transactions by sender
app.get("/transactions/:sender", async (req, res) => {
    try {
        const { sender } = req.params;
        if (!sender) {
            return res.status(400).json({ Err: null });
        }
        const transactions = await TransactionDB.getTransactionsBySender(sender);
        console.log(`Transactions fetched for sender ${sender}:`, transactions.length);
        res.json({ Ok: transactions });
    }
    catch (e) {
        console.error("Failed to fetch transactions for sender:", e);
        res.status(500).json({ Err: null });
    }
});
// Start the server
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8000;
// Initialize SQLite then start Express
(async () => {
    try {
        await TransactionDB.initializeTransactionsDatabase();
        app.listen(PORT, () => {
            console.log(`🚀 Server running on http://localhost:${PORT}`);
        });
    }
    catch (err) {
        console.error("Failed to initialize the application:", err);
        process.exit(1);
    }
})();
