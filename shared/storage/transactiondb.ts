import Database from "better-sqlite3";
import fs from "fs";
import path from "path";


export interface Transaction {
  txId: string;
  sender: string;
  value: string;
  type: TransactionType;
  txTimestamp: number;                // Source bridge tx timestamp (ms)
  chainId: number;
  status: TransactionStatus;
  receiptId: string;
  tssSender?: string | null;          // TSS sender address used for this tx
  nonce?: number | null;              // EVM tssSender account nonce from the on-chain receipt; null for Liberdus txs
  receiptTimestamp?: number | null;   // Liberdus tssSender receipt timestamp (ms); null for EVM txs
  reason?: string | null;             // Reason for failure
  executionHistory?: string | null;   // JSON: tracks failed/incompleted tx attempts
  createdAt?: number;
  updatedAt?: number;
}

// Chain-native receipt reference:
//   - 'nonce'            → EVM tssSender account nonce
//   - 'receiptTimestamp' → Liberdus receipt timestamp (ms)
export type TxReceiptRef =
  | { type: 'nonce'; value: number }
  | { type: 'receiptTimestamp'; value: number }
  | null;

export const txNonce = (value: number): TxReceiptRef => ({ type: 'nonce', value });
export const txReceiptTimestamp = (value: number): TxReceiptRef => ({ type: 'receiptTimestamp', value });

export interface ExecutionHistoryEntry {
  status: TransactionStatus;
  receiptId?: string;
  reason?: string;
}

export enum TransactionStatus {
  PENDING = 0,
  SUBMITTED = 1,    // Tx submitted to the network
  COMPLETED = 2,    // Tx successfully executed
  INCOMPLETED = 3,  // Tx submitted to chain but not processed by the chain
  FAILED = 4,       // Tx failed in execution on chain
  REVERTED = 5,     // Tx returned to sender (source bridge tx didn't meet criteria)
}

export enum TransactionType {
  BRIDGE_IN = 0,    // Liberdus → EVM: observer detects Liberdus transfer, party calls bridgeIn on EVM
  BRIDGE_OUT = 1,   // EVM → Liberdus: observer detects BridgedOut on EVM, party sends coin on Liberdus
  BRIDGE_VAULT = 2,
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
    value === TransactionStatus.SUBMITTED ||
    value === TransactionStatus.COMPLETED ||
    value === TransactionStatus.INCOMPLETED ||
    value === TransactionStatus.FAILED ||
    value === TransactionStatus.REVERTED
  );
}

export function getStatusLabel(status: TransactionStatus): string {
  return isTransactionStatus(status) ? TransactionStatus[status] : `UNKNOWN(${status})`;
}

// ---------------------------------------------------------------------------
// Module-level DB instance — initialized once via initializeTransactionsDatabase
// ---------------------------------------------------------------------------

let db: Database.Database;

// Prepared statements (set up during initialization for hot-path queries)
let stmtGetById: Database.Statement;
let stmtGetByReceiptId: Database.Statement;
let stmtInsert: Database.Statement;
let stmtUpdateStatus: Database.Statement;

export function initializeTransactionsDatabase(dbPath: string): void {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // Wait up to 5s when another writer holds the lock before returning SQLITE_BUSY
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      txId             TEXT NOT NULL UNIQUE PRIMARY KEY,
      sender           TEXT NOT NULL,
      value            TEXT NOT NULL,
      type             INTEGER NOT NULL,
      txTimestamp      BIGINT NOT NULL,
      receiptId        TEXT NOT NULL,
      chainId          INTEGER NOT NULL,
      status           INTEGER NOT NULL,
      tssSender        TEXT,
      nonce            INTEGER,
      receiptTimestamp BIGINT,
      reason           TEXT,
      executionHistory TEXT DEFAULT '{}',
      createdAt        INTEGER DEFAULT (strftime('%s','now')),
      updatedAt        INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TRIGGER IF NOT EXISTS trg_transactions_updatedAt
    AFTER UPDATE ON transactions FOR EACH ROW
    BEGIN
      UPDATE transactions SET updatedAt = strftime('%s','now') WHERE txId = OLD.txId;
    END;

    CREATE INDEX IF NOT EXISTS idx_transactions_status_txTimestamp
      ON transactions(status, txTimestamp);
    CREATE INDEX IF NOT EXISTS idx_transactions_sender
      ON transactions(sender);
    CREATE INDEX IF NOT EXISTS idx_transactions_type
      ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_transactions_receiptId
      ON transactions(receiptId);
    CREATE INDEX IF NOT EXISTS idx_transactions_chain_tssSender_nonce
      ON transactions(chainId, tssSender, nonce);
    CREATE INDEX IF NOT EXISTS idx_transactions_chain_tssSender_status_nonce
      ON transactions(chainId, tssSender, status, nonce);
  `);

  // Migration: add receiptTimestamp column to existing databases (must run before the index below)
  try {
    db.exec("ALTER TABLE transactions ADD COLUMN receiptTimestamp BIGINT");
  } catch {
    // Column already exists — expected on all but first run after this deploy
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_receiptTimestamp
      ON transactions(receiptTimestamp);
  `);

  stmtGetById = db.prepare("SELECT * FROM transactions WHERE txId = ?");
  stmtGetByReceiptId = db.prepare("SELECT * FROM transactions WHERE receiptId = ? ORDER BY updatedAt DESC LIMIT 1");

  stmtInsert = db.prepare(`
    INSERT OR IGNORE INTO transactions
      (txId, sender, value, type, txTimestamp, receiptId, chainId, status, tssSender, nonce, receiptTimestamp, reason, executionHistory)
    VALUES
      (@txId, @sender, @value, @type, @txTimestamp, @receiptId, @chainId, @status, @tssSender, @nonce, @receiptTimestamp, @reason, @executionHistory)
  `);

  stmtUpdateStatus = db.prepare(
    "UPDATE transactions SET status = @status, receiptId = @receiptId, tssSender = @tssSender, nonce = @nonce, receiptTimestamp = @receiptTimestamp, reason = @reason, executionHistory = @executionHistory WHERE txId = @txId"
  );

  console.log("[db] initialized");
}

// ---------------------------------------------------------------------------
// Public API — all synchronous
// ---------------------------------------------------------------------------

export function saveTransaction(transaction: Transaction): void {
  const result = stmtInsert.run({
    txId: transaction.txId,
    sender: transaction.sender,
    value: transaction.value,
    type: transaction.type,
    txTimestamp: transaction.txTimestamp,
    receiptId: transaction.receiptId,
    chainId: transaction.chainId,
    status: transaction.status,
    tssSender: transaction.tssSender ?? null,
    nonce: transaction.nonce ?? null,
    receiptTimestamp: transaction.receiptTimestamp ?? null,
    reason: transaction.reason ?? null,
    executionHistory: transaction.executionHistory ?? "{}",
  });
  if (result.changes === 0) {
    console.warn(`[db] saveTransaction: txId ${transaction.txId} already exists — insert ignored`);
  }
}

export function updateTransactionSource(
  txId: string,
  data: {
    chainId: number;
    txTimestamp: number;
    sender?: string;
    txType?: TransactionType;
    status?: TransactionStatus;
  }
): void {
  const { chainId, txTimestamp, sender, txType, status } = data;

  let sql = "UPDATE transactions SET chainId = @chainId, txTimestamp = @txTimestamp";
  const params: Record<string, any> = { chainId, txTimestamp, txId };

  if (sender !== undefined) {
    sql += ", sender = @sender";
    params.sender = sender;
  }
  if (txType !== undefined) {
    sql += ", type = @type";
    params.type = txType;
  }
  if (status !== undefined) {
    sql += ", status = @status";
    params.status = status;
  }
  sql += " WHERE txId = @txId";

  const result = db.prepare(sql).run(params);
  if (result.changes === 0) {
    console.warn(`[db] updateTransactionSource: txId ${txId} not found — no rows updated`);
  }
}

/**
 * Atomically reads the current status, applies transition guards, and updates
 * the status if the transition is allowed.
 *
 * Guards (in priority order):
 *   1. Idempotent: same status + receiptId already stored → 'duplicate'
 *   2. No COMPLETED → anything else downgrade → 'no_downgrade'
 *   3. No FAILED → INCOMPLETED downgrade → 'no_downgrade'
 *
 * Uses BEGIN IMMEDIATE so the read-check-write block is held under a single
 * write lock across both the observer and tss-party processes.
 */
export type UpdateStatusResult = "ok" | "not_found" | "duplicate" | "no_downgrade";

export function updateTransactionStatus(
  txId: string,
  status: TransactionStatus,
  receiptId: string,
  tssSender: string,
  receiptRef: TxReceiptRef,
  reason: string | null,
): UpdateStatusResult {
  const run = db.transaction((): UpdateStatusResult => {
    const current = stmtGetById.get(txId) as Transaction | undefined;
    if (!current) return "not_found";

    const currentReason = current.reason ?? null;
    const nextReason = reason ?? null;
    const revertedReasonChanged =
      current.status === TransactionStatus.REVERTED &&
      status === TransactionStatus.REVERTED &&
      nextReason !== null &&
      currentReason !== nextReason;

    // INCOMPLETED is exempt so a retry with a new reason always overwrites the previous failure message.
    if (
      status !== TransactionStatus.INCOMPLETED &&
      !revertedReasonChanged &&
      current.status === status &&
      current.receiptId === receiptId
    ) return "duplicate";

    if (
      current.status === TransactionStatus.COMPLETED &&
      status !== TransactionStatus.COMPLETED
    ) {
      return "no_downgrade";
    }

    if (current.status === TransactionStatus.REVERTED && !revertedReasonChanged) {
      return "no_downgrade";
    }

    // FAILED (on-chain execution failure) is terminal — cannot downgrade to INCOMPLETED
    if (
      current.status === TransactionStatus.FAILED &&
      status === TransactionStatus.INCOMPLETED
    ) {
      return "no_downgrade";
    }

    // Use the passed-in nonce/receiptTimestamp if provided, otherwise fall back to the row's existing values
    const effectiveTssSender = tssSender ?? current.tssSender;
    const effectiveNonce =
      receiptRef?.type === 'nonce' ? receiptRef.value : current.nonce;
    const effectiveReceiptTimestamp =
      receiptRef?.type === 'receiptTimestamp' ? receiptRef.value : current.receiptTimestamp;

    // Auto-append to executionHistory when transitioning to INCOMPLETED or FAILED
    // and a nonce is known (meaning a signing attempt was made).
    let updatedHistory = current.executionHistory || "{}";
    if (
      (status === TransactionStatus.INCOMPLETED || status === TransactionStatus.FAILED) &&
      effectiveNonce != null
    ) {
      const history: Record<string, ExecutionHistoryEntry> = JSON.parse(updatedHistory);
      history[String(effectiveNonce)] = {
        status,
        receiptId: receiptId || undefined,
        reason: reason || undefined,
      };
      updatedHistory = JSON.stringify(history);
    }

    stmtUpdateStatus.run({
      status,
      receiptId,
      tssSender: effectiveTssSender ?? null,
      nonce: effectiveNonce ?? null,
      receiptTimestamp: effectiveReceiptTimestamp ?? null,
      reason,
      executionHistory: updatedHistory,
      txId,
    });
    return "ok";
  });

  return run();
}

export function getTransactionById(txId: string): Transaction | null {
  return (stmtGetById.get(txId) as Transaction) ?? null;
}

export function getTransactionByReceiptId(receiptId: string): Transaction | null {
  if (!receiptId) return null;
  return (stmtGetByReceiptId.get(receiptId) as Transaction) ?? null;
}

export function getTotalTransactions(options?: {
  sender?: string;
  type?: TransactionType;
  status?: TransactionStatus;
  unprocessed?: boolean;
  partyRetryable?: boolean;
}): number {
  const { sql, params } = buildWhereClause(options);
  const query = `SELECT COUNT(*) as count FROM transactions${sql ? ` WHERE ${sql}` : ""}`;
  const row = db.prepare(query).get(params) as { count: number };
  return row?.count ?? 0;
}

export function getTransactionsByPage(
  limit: number,
  offset: number,
  options?: {
    sender?: string;
    type?: TransactionType;
    status?: TransactionStatus;
    unprocessed?: boolean;
    partyRetryable?: boolean;
  }
): Transaction[] {
  const { sql, params } = buildWhereClause(options);
  const orderBy = options?.unprocessed ? "txTimestamp ASC" : "txTimestamp DESC";
  const query = `SELECT * FROM transactions${sql ? ` WHERE ${sql}` : ""} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`;
  return db.prepare(query).all({ ...params, limit, offset }) as Transaction[];
}

export function getTransactionCountsByStatus(): {
  pending: number;
  submitted: number;
  completed: number;
  incompleted: number;
  failed: number;
  reverted: number;
} {
  const rows = db
    .prepare("SELECT status, COUNT(*) as count FROM transactions GROUP BY status")
    .all() as { status: number; count: number }[];
  const map = new Map(rows.map((r) => [r.status, r.count]));
  return {
    pending:     map.get(TransactionStatus.PENDING)     ?? 0,
    submitted:   map.get(TransactionStatus.SUBMITTED)   ?? 0,
    completed:   map.get(TransactionStatus.COMPLETED)   ?? 0,
    incompleted: map.get(TransactionStatus.INCOMPLETED) ?? 0,
    failed:      map.get(TransactionStatus.FAILED)      ?? 0,
    reverted:    map.get(TransactionStatus.REVERTED)    ?? 0,
  };
}

export function appendExecutionHistory(
  txId: string,
  key: string,
  entry: ExecutionHistoryEntry,
): void {
  const run = db.transaction(() => {
    const current = stmtGetById.get(txId) as Transaction | undefined;
    if (!current) {
      console.warn(`[db] appendExecutionHistory: txId ${txId} not found`);
      return;
    }
    const history: Record<string, ExecutionHistoryEntry> = JSON.parse(current.executionHistory || "{}");
    history[key] = entry;
    db.prepare("UPDATE transactions SET executionHistory = @history WHERE txId = @txId").run({
      history: JSON.stringify(history),
      txId,
    });
  });
  run();
}

export function getExecutionHistory(
  txId: string,
): Record<string, ExecutionHistoryEntry> | null {
  const row = stmtGetById.get(txId) as Transaction | undefined;
  if (!row) return null;
  return JSON.parse(row.executionHistory || "{}");
}

export function getTransactionsByNonceRange(
  chainId: number,
  tssSender: string,
  fromNonce: number,
  toNonce: number,
): Transaction[] {
  return db
    .prepare(
      "SELECT * FROM transactions WHERE chainId = @chainId AND tssSender = @tssSender AND nonce >= @fromNonce AND nonce < @toNonce ORDER BY nonce ASC"
    )
    .all({ chainId, tssSender, fromNonce, toNonce }) as Transaction[];
}

// Returns the highest EVM nonce stored for the given sender on the given chain.
// INCOMPLETED is excluded — its nonce is in-flight and not yet confirmed.
export function getMaxNonceForSender(chainId: number, tssSender: string): number | null {
  const row = db.prepare(
    "SELECT MAX(nonce) AS maxNonce FROM transactions WHERE chainId = @chainId AND tssSender = @tssSender AND nonce IS NOT NULL AND status IN (@completed, @failed, @reverted)"
  ).get({ chainId, tssSender, completed: TransactionStatus.COMPLETED, failed: TransactionStatus.FAILED, reverted: TransactionStatus.REVERTED }) as { maxNonce: number | null } | undefined
  return row?.maxNonce ?? null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildWhereClause(options?: {
  sender?: string;
  type?: TransactionType;
  status?: TransactionStatus;
  unprocessed?: boolean;
  partyRetryable?: boolean;
}): { sql: string; params: Record<string, any> } {
  const clauses: string[] = [];
  const params: Record<string, any> = {};

  if (options?.sender) {
    clauses.push("sender = @sender");
    params.sender = options.sender;
  }
  if (options?.type !== undefined) {
    clauses.push("type = @type");
    params.type = options.type;
  }
  if (options?.unprocessed) {
    // Not yet in a terminal state (COMPLETED/FAILED/REVERTED).
    clauses.push(`status IN (${TransactionStatus.PENDING}, ${TransactionStatus.SUBMITTED}, ${TransactionStatus.INCOMPLETED})`);
    if (options.partyRetryable) {
      // receiptTimestamp IS NULL excludes Liberdus txs already in SUBMITTED/INCOMPLETED — they've been
      // submitted to the Liberdus network and should not be retried by the party.
      clauses.push("receiptTimestamp IS NULL");
    }
  } else if (options?.status !== undefined) {
    clauses.push("status = @status");
    params.status = options.status;
  }

  return { sql: clauses.join(" AND "), params };
}
