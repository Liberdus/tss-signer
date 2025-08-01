import SQLiteManager from "./sqliteManager";

// Define the interface for a transaction
export interface Transaction {
  txId: string;
  sender: string;
  value: string;
  type: TransactionType;
  txTimestamp: number;
  chainId: number;
  status: TransactionStatus;
  receipt: string;
  reason?: string | null; // Optional field for error reason
  createdAt?: string;
  updatedAt?: string;
}

export enum TransactionStatus {
  PENDING = 0,
  PROCESSING = 1,
  COMPLETED = 2,
  FAILED = 3,
}

export enum TransactionType {
  BRIDGE_IN = 0, // COIN to TOKEN
  BRIDGE_OUT = 1, // TOKEN to COIN
}

export function isTransactionType(value: any): value is TransactionType {
  return (
    value === TransactionType.BRIDGE_IN || value === TransactionType.BRIDGE_OUT
  );
}

export function isTransactionStatus(value: any): value is TransactionStatus {
  return (
    value === TransactionStatus.PENDING ||
    value === TransactionStatus.PROCESSING ||
    value === TransactionStatus.COMPLETED ||
    value === TransactionStatus.FAILED
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
    receipt: "TEXT NOT NULL",
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
}

/**
 * Save a new transaction to the database
 * @param transaction - Transaction object to insert
 */
export async function saveTransaction(transaction: Transaction): Promise<void> {
  await db.insert("transactions", transaction);
}

/**
 * Update the status of a transaction by txId
 * @param txId - Unique transaction ID
 * @param status - New status value
 */
export async function updateTransactionStatus(
  txId: string,
  status: TransactionStatus,
  receipt: string,
  reason: string | null
): Promise<void> {
  if (reason !== "") {
    await db.update("transactions", { status, receipt, reason }, "txId = ?", [txId]);
    return;
  } else {
    await db.update("transactions", { status, receipt }, "txId = ?", [txId]);
  }
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
}): Promise<number> {
  let whereClause = "";
  const params: (string | number)[] = [];

  if (options?.sender) {
    appendAndClause(whereClause, params);
    whereClause += "sender = ?";
    params.push(options.sender);
  }
  if (options?.type !== undefined) {
    appendAndClause(whereClause, params);
    whereClause += "type = ?";
    params.push(options.type);
  }
  if (options?.status !== undefined) {
    appendAndClause(whereClause, params);
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
  }
): Promise<Transaction[]> {
  let whereClause = "";
  const params: (string | number)[] = [];

  if (options?.sender) {
    appendAndClause(whereClause, params);
    whereClause += "sender = ?";
    params.push(options.sender);
  }
  if (options?.type !== undefined) {
    appendAndClause(whereClause, params);
    whereClause += "type = ?";
    params.push(options.type);
  }
  if (options?.status !== undefined) {
    appendAndClause(whereClause, params);
    whereClause += "status = ?";
    params.push(options.status);
  }

  const query = `SELECT * FROM transactions ${
    whereClause ? `WHERE ${whereClause}` : ""
  } ORDER BY createdAt DESC LIMIT ? OFFSET ?`;

  params.push(limit, offset);

  return await db.all<Transaction>(query, params);
}

// Helper function to append "AND" to SQL query
const appendAndClause = (sql: string, inputs: any[]) => {
  if (inputs.length > 0) sql += " AND ";
};
