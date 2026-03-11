import SQLiteManager from "./sqliteManager";

// Liberdus network chain ID (matches DEFAULT_CHAIN_ID in the token contract)
export const LIBERDUS_CHAIN_ID = 0;

// Define the interface for a transaction
export interface Transaction {
  txId: string;
  sender: string;
  value: string;
  type: TransactionType;
  txTimestamp: number;
  chainId: number;
  status: TransactionStatus;
  receiptId: string;
  reason?: string | null; // Optional field for error reason
  createdAt?: string;
  updatedAt?: string;
}

export enum TransactionStatus {
  PENDING = 0,
  PROCESSING = 1,
  COMPLETED = 2,
  FAILED = 3,
  REVERTED = 4, // tx executed but reverted on-chain
}

export enum TransactionType {
  BRIDGE_IN = 0,    // COIN to TOKEN (Liberdus → EVM)
  BRIDGE_OUT = 1,   // TOKEN to COIN (EVM → Liberdus)
  BRIDGE_VAULT = 2, // VAULT to SECONDARY (vault chain → secondary EVM chain)
}

export function isTransactionType(value: any): value is TransactionType {
  return (
    value === TransactionType.BRIDGE_IN ||
    value === TransactionType.BRIDGE_OUT ||
    value === TransactionType.BRIDGE_VAULT
  );
}

export function isTransactionStatus(value: any): value is TransactionStatus {
  return (
    value === TransactionStatus.PENDING ||
    value === TransactionStatus.PROCESSING ||
    value === TransactionStatus.COMPLETED ||
    value === TransactionStatus.FAILED ||
    value === TransactionStatus.REVERTED
  );
}

// Initialize the database
const dbPath = "./transactions.sqlite"; // Update path as needed
const db = new SQLiteManager(dbPath);

// Initialize and create the transactions table
export async function initializeTransactionsDatabase(): Promise<void> {
  await db.initialize();
  await db.createTableIfNotExists("transactions", {
    txId: "TEXT NOT NULL UNIQUE PRIMARY KEY",
    sender: "TEXT NOT NULL",
    value: "TEXT NOT NULL",
    type: "INTEGER NOT NULL",
    txTimestamp: "BIGINT NOT NULL", // assume this is from blockchain or external source
    receiptId: "TEXT NOT NULL",
    chainId: "INTEGER NOT NULL",
    status: "INTEGER NOT NULL",
    reason: "TEXT",
    createdAt: "INTEGER DEFAULT (strftime('%s','now'))",
    updatedAt: "INTEGER DEFAULT (strftime('%s','now'))",
  });
  
  await db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_transactions_updatedAt
    AFTER UPDATE ON transactions
    FOR EACH ROW
    BEGIN
        UPDATE transactions
        SET updatedAt = strftime('%s','now')
        WHERE txId = OLD.txId;
    END;
  `);

  // Indexes for common query patterns
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_status_txTimestamp
      ON transactions(status, txTimestamp);
    CREATE INDEX IF NOT EXISTS idx_transactions_sender
      ON transactions(sender);
    CREATE INDEX IF NOT EXISTS idx_transactions_type
      ON transactions(type);
  `);
}

/**
 * Save a new transaction to the database
 * @param transaction - Transaction object to insert
 */
export async function saveTransaction(transaction: Transaction): Promise<void> {
  const result = await db.insert("transactions", transaction);
  if (result.changes === 0) {
    console.warn(`[db] saveTransaction: txId ${transaction.txId} already exists — insert ignored`);
  }
}

/**
 * Update the source-side fields of a transaction that was pre-populated by the
 * BridgedIn scanner before the originating source event (BridgedOut / Liberdus)
 * was observed. Always updates chainId and txTimestamp; updates sender and
 * txType with the authoritative source-side values when they differ from the
 * early-saved placeholders.
 */
export async function updateTransactionSource(
  txId: string,
  data: {
    chainId: number;
    txTimestamp: number;
    sender?: string;
    txType?: TransactionType;
  }
): Promise<void> {
  const { chainId, txTimestamp, sender, txType } = data;
  const fields: Record<string, number | string> = { chainId, txTimestamp };
  if (sender !== undefined) fields.sender = sender;
  if (txType !== undefined) fields.type = txType;
  await db.update("transactions", fields, "txId = ?", [txId]);
}

/**
 * Update the status of a transaction by txId
 * @param txId - Unique transaction ID
 * @param status - New status value
 */
export async function updateTransactionStatus(
  txId: string,
  status: TransactionStatus,
  receiptId: string,
  reason: string | null
): Promise<void> {
  const effectiveReason = status === TransactionStatus.FAILED ? (reason ?? "") : "";
  await db.update("transactions", { status, receiptId, reason: effectiveReason }, "txId = ?", [txId]);
}

/**
 * Retrieve a transaction by its txId
 * @param txId - Unique transaction ID
 * @returns Transaction object or null
 */
export async function getTransactionById(
  txId: string
): Promise<Transaction | null> {
  return await db.get<Transaction>(
    "SELECT * FROM transactions WHERE txId = ?",
    [txId]
  );
}

/**
 * Retrieve total transactions count based on optional filters.
 * @param options - An object containing optional filters:
 * - sender: Sender's address
 * - type: TransactionType
 * - status: TransactionStatus
 * @returns Total transactions count
 */
export async function getTotalTransactions(options?: {
  sender?: string;
  type?: TransactionType;
  status?: TransactionStatus;
  unprocessed?: boolean; // when true, matches PENDING + PROCESSING (status IN (0,1))
}): Promise<number> {
  let whereClause = "";
  const params: (string | number)[] = [];

  if (options?.sender) {
    whereClause = appendAndClause(whereClause, params);
    whereClause += "sender = ?";
    params.push(options.sender);
  }
  if (options?.type !== undefined) {
    whereClause = appendAndClause(whereClause, params);
    whereClause += "type = ?";
    params.push(options.type);
  }
  if (options?.unprocessed) {
    whereClause = appendAndClause(whereClause, params);
    whereClause += "status IN (0, 1)";
  } else if (options?.status !== undefined) {
    whereClause = appendAndClause(whereClause, params);
    whereClause += "status = ?";
    params.push(options.status);
  }

  return await db.count("transactions", whereClause, params);
}

/**
 * Retrieve transactions by page with optional filters.
 * @param limit - Number of items to return per page
 * @param offset - Number of items to skip
 * @param options - An object containing optional filters:
 * - sender: Sender's address
 * - type: TransactionType
 * - status: TransactionStatus
 * @returns Array of Transaction objects
 */
export async function getTransactionsByPage(
  limit: number,
  offset: number,
  options?: {
    sender?: string;
    type?: TransactionType;
    status?: TransactionStatus;
    unprocessed?: boolean; // when true, matches PENDING + PROCESSING (status IN (0,1))
  }
): Promise<Transaction[]> {
  let whereClause = "";
  const params: (string | number)[] = [];

  if (options?.sender) {
    whereClause = appendAndClause(whereClause, params);
    whereClause += "sender = ?";
    params.push(options.sender);
  }
  if (options?.type !== undefined) {
    whereClause = appendAndClause(whereClause, params);
    whereClause += "type = ?";
    params.push(options.type);
  }
  if (options?.unprocessed) {
    whereClause = appendAndClause(whereClause, params);
    whereClause += "status IN (0, 1)";
  } else if (options?.status !== undefined) {
    whereClause = appendAndClause(whereClause, params);
    whereClause += "status = ?";
    params.push(options.status);
  }

  const orderBy = options?.unprocessed ? "txTimestamp ASC" : "txTimestamp DESC";
  const query = `SELECT * FROM transactions ${
    whereClause ? `WHERE ${whereClause}` : ""
  } ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

  params.push(limit, offset);

  return await db.all<Transaction>(query, params);
}

/**
 * Returns transaction counts grouped by status in a single query.
 */
export async function getTransactionCountsByStatus(): Promise<{
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  reverted: number;
}> {
  const rows = await db.all<{ status: number; count: number }>(
    "SELECT status, COUNT(*) as count FROM transactions GROUP BY status"
  );
  const map = new Map(rows.map((r) => [r.status, r.count]));
  return {
    pending:    map.get(TransactionStatus.PENDING)    ?? 0,
    processing: map.get(TransactionStatus.PROCESSING) ?? 0,
    completed:  map.get(TransactionStatus.COMPLETED)  ?? 0,
    failed:     map.get(TransactionStatus.FAILED)     ?? 0,
    reverted:   map.get(TransactionStatus.REVERTED)   ?? 0,
  };
}

// Helper function to append "AND" to SQL query
const appendAndClause = (sql: string, inputs: any[]): string => {
  if (inputs.length > 0) return sql + " AND ";
  return sql;
};
