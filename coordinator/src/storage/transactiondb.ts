import SQLiteManager from "./sqliteManager";

// Define the interface for a transaction
export interface Transaction {
  txId: string;
  sender: string;
  value: string;
  type: string;
  tssReceipt: string;
  originalTx: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
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
    type: "TEXT NOT NULL",
    tssReceipt: "TEXT NOT NULL",
    originalTx: "TEXT NOT NULL",
    status: "TEXT NOT NULL",
    createdAt: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
    updatedAt: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
  });
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
  status: string,
  tssReceipt: string
): Promise<void> {
  await db.update(
    "transactions",
    { status, tssReceipt, updatedAt: new Date().toISOString() },
    "txId = ?",
    [txId]
  );
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
 * Retrieve total transactions count
 * @returns Total transactions count
 */
export async function getTotalTransactions(): Promise<number> {
  return await db.count("transactions");
}

/**
 * Retrieve transactions by page
 * @param limit - Number of items to return per page
 * @param offset - Number of items to skip
 * @returns Array of Transaction objects
 */
export async function getTransactionsByPage(
  limit: number,
  offset: number
): Promise<Transaction[]> {
  // Add total txs count
  return await db.all<Transaction>(
    "SELECT * FROM transactions ORDER BY createdAt DESC LIMIT ? OFFSET ?",
    [limit, offset]
  );
}

/**
 * Retrieve total transactions count by sender
 * @param sender - Sender's address
 * @returns Total transactions count
 */
export async function getTotalTransactionsBySender(
  sender: string
): Promise<number> {
  return await db.count("transactions", "sender = ?", [sender]);
}

/**
 * Retrieve transactions by sender
 * @param sender - Sender's address
 * @param limit - Number of items to return per page
 * @param offset - Number of items to skip
 * @returns Array of Transaction objects
 */
export async function getTransactionsBySender(
  sender: string,
  limit: number,
  offset: number
): Promise<Transaction[]> {
  return await db.all<Transaction>(
    "SELECT * FROM transactions WHERE sender = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?",
    [sender, limit, offset]
  );
}
