import SQLiteManager from "./sqliteManager";

// Define the interface for a transaction
export interface Transaction {
  tssReceipt: string;
  originalTx: string;
  sender: string;
  value: string;
  txId: string;
  type: string;
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
  status: string
): Promise<void> {
  await db.update(
    "transactions",
    { status, updatedAt: new Date().toISOString() },
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
 * Retrieve all transactions
 * @returns Array of Transaction objects
 */
export async function getAllTransactions(): Promise<Transaction[]> {
  return await db.all<Transaction>(
    "SELECT * FROM transactions ORDER BY createdAt DESC"
  );
}
/**
 * Retrieve transactions by sender
 * @param sender - Sender's address
 * @returns Array of Transaction objects
 */
export async function getTransactionsBySender(
  sender: string
): Promise<Transaction[]> {
  return await db.all<Transaction>(
    "SELECT * FROM transactions WHERE sender = ? ORDER BY createdAt DESC",
    [sender]
  );
}
