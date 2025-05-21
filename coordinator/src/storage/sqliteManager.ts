/**
 * SQLite3 Database Manager
 * A comprehensive module for SQLite3 database operations
 */
import sqlite3, { Statement } from "sqlite3";
import path from "path";
import fs from "fs";
import { promisify } from "util";

// Define interfaces for better type safety
interface SQLiteManagerOptions {
  verbose?: boolean;
  inMemory?: boolean;
}

interface QueryResult {
  lastID: number;
  changes: number;
}

interface MigrationRecord {
  name: string;
}

interface CountResult {
  count: number;
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: any;
  pk: number;
}

interface TableSchema {
  [columnName: string]: string;
}

interface TableData {
  [columnName: string]: any;
}

interface PromisifiedStatement {
  runAsync: (params?: any[]) => Promise<{ lastID: number; changes: number }>;
  getAsync: (params?: any[]) => Promise<any>;
  allAsync: (params?: any[]) => Promise<any[]>;
  eachAsync: (params: any[], callback: (row: any) => void) => Promise<number>;
  finalizeAsync: () => Promise<void>;
  run: {
    (callback?: (err: Error | null) => void): void;
    (params: any, callback?: (err: Error | null) => void): void;
    (...params: any[]): void;
  };
  get: (
    params?: any[],
    callback?: (err: Error | null, row?: any) => void
  ) => void;
  all: (
    params?: any[],
    callback?: (err: Error | null, rows?: any[]) => void
  ) => void;
  each: (
    params: any[],
    rowCallback: (err: Error | null, row?: any) => void,
    completeCallback: (err: Error | null, count?: number) => void
  ) => void;
  finalize: (callback?: (err: Error) => void) => sqlite3.Database;
}

class SQLiteManager {
  private sqlite: typeof sqlite3;
  private dbPath: string;
  private db: sqlite3.Database | null;
  private isInitialized: boolean;

  /**
   * Create a new SQLite database manager
   * @param {string} dbPath - Path to the database file
   * @param {SQLiteManagerOptions} options - Database configuration options
   */
  constructor(dbPath: string, options: SQLiteManagerOptions = {}) {
    const { verbose = false, inMemory = false } = options;

    // Enable verbose mode if requested
    this.sqlite = verbose ? sqlite3.verbose() : sqlite3;

    // Set database path
    this.dbPath = inMemory ? ":memory:" : dbPath;

    // Database handle will be set during initialization
    this.db = null;

    // Track if database is initialized
    this.isInitialized = false;
  }

  /**
   * Initialize the database connection
   * @param {boolean} createDir - Create directory if it doesn't exist
   * @returns {Promise<void>}
   */
  initialize(createDir = true): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isInitialized) {
        return resolve();
      }

      // Create directory if it doesn't exist and we're not using in-memory DB
      if (createDir && this.dbPath !== ":memory:") {
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
        }
      }

      // Connect to database
      this.db = new this.sqlite.Database(
        this.dbPath,
        sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
        (err) => {
          if (err) {
            return reject(new Error(`Failed to open database: ${err.message}`));
          }

          // Enable foreign keys
          if (this.db) {
            this.db.run("PRAGMA foreign_keys = ON", (pragmaErr) => {
              if (pragmaErr) {
                console.warn(
                  "Failed to enable foreign keys:",
                  pragmaErr.message
                );
              }

              this.isInitialized = true;
              resolve();
            });
          }
        }
      );
    });
  }

  /**
   * Close the database connection
   * @returns {Promise<void>}
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return resolve();
      }

      this.db.close((err) => {
        if (err) {
          return reject(new Error(`Failed to close database: ${err.message}`));
        }
        this.isInitialized = false;
        this.db = null;
        resolve();
      });
    });
  }

  /**
   * Execute a SQL query that doesn't return data
   * @param {string} sql - SQL query to execute
   * @param {any[] | object} params - Query parameters
   * @returns {Promise<QueryResult>}
   */
  run(sql: string, params: any[] | object = []): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      this._ensureConnection();

      if (this.db) {
        this.db.run(
          sql,
          params,
          function (this: sqlite3.RunResult, err: Error | null) {
            if (err) {
              return reject(new Error(`Query execution error: ${err.message}`));
            }

            // Return info about the executed query
            resolve({
              lastID: this.lastID,
              changes: this.changes,
            });
          }
        );
      }
    });
  }

  /**
   * Execute a SQL query and return the first row
   * @param {string} sql - SQL query to execute
   * @param {any[] | object} params - Query parameters
   * @returns {Promise<T | null>} - Returns a single row or null
   */
  get<T = any>(sql: string, params: any[] | object = []): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this._ensureConnection();

      if (this.db) {
        this.db.get(sql, params, (err, row) => {
          if (err) {
            return reject(new Error(`Query execution error: ${err.message}`));
          }
          resolve((row as T) || null);
        });
      }
    });
  }

  /**
   * Execute a SQL query and return all rows
   * @param {string} sql - SQL query to execute
   * @param {any[] | object} params - Query parameters
   * @returns {Promise<T[]>} - Returns an array of rows
   */
  all<T = any>(sql: string, params: any[] | object = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this._ensureConnection();

      if (this.db) {
        this.db.all(sql, params, (err, rows) => {
          if (err) {
            return reject(new Error(`Query execution error: ${err.message}`));
          }
          resolve((rows as T[]) || []);
        });
      }
    });
  }

  /**
   * Execute a SQL query and process rows one by one
   * @param {string} sql - SQL query to execute
   * @param {any[] | object} params - Query parameters
   * @param {function} callback - Function to process each row
   * @returns {Promise<{rowCount: number}>}
   */
  each<T = any>(
    sql: string,
    params: any[] | object = [],
    callback: (row: T) => void
  ): Promise<{ rowCount: number }> {
    return new Promise((resolve, reject) => {
      this._ensureConnection();

      if (this.db) {
        this.db.each(
          sql,
          params,
          // Row callback
          (err, row) => {
            if (err) {
              return reject(new Error(`Error processing row: ${err.message}`));
            }
            callback(row as T);
          },
          // Completion callback
          (err, rowCount) => {
            if (err) {
              return reject(new Error(`Query execution error: ${err.message}`));
            }
            resolve({ rowCount });
          }
        );
      }
    });
  }

  /**
   * Execute multiple SQL statements
   * @param {string} sql - SQL statements to execute
   * @returns {Promise<void>}
   */
  exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this._ensureConnection();

      if (this.db) {
        this.db.exec(sql, (err) => {
          if (err) {
            return reject(new Error(`Failed to execute SQL: ${err.message}`));
          }
          resolve();
        });
      }
    });
  }

  /**
   * Prepare and return an SQL statement
   * @param {string} sql - SQL query to prepare
   * @param {any[] | object} params - Default parameters
   * @returns {PromisifiedStatement} - Returns prepared statement
   */

  prepare(sql: string, params: any[] | object = []): PromisifiedStatement {
    this._ensureConnection();

    if (!this.db) {
      throw new Error("Database is not initialized.");
    }

    const stmt = this.db.prepare(sql, params) as Statement;

    const promisifiedStmt: PromisifiedStatement =
      stmt as unknown as PromisifiedStatement;

    promisifiedStmt.runAsync = (params?: any[]) => {
      return new Promise<{ lastID: number; changes: number }>(
        (resolve, reject) => {
          stmt.run(
            params || [],
            function (this: sqlite3.RunResult, err: Error | null) {
              if (err) return reject(err);
              resolve({ lastID: this.lastID, changes: this.changes });
            }
          );
        }
      );
    };

    promisifiedStmt.getAsync = promisify(stmt.get).bind(stmt);
    promisifiedStmt.allAsync = promisify(stmt.all).bind(stmt) as (
      params?: any[]
    ) => Promise<any[]>;

    promisifiedStmt.eachAsync = (
      params: any[],
      callback: (row: any) => void
    ): Promise<number> => {
      return new Promise((resolve, reject) => {
        stmt.each(
          params,
          (err: Error | null, row: any) => {
            if (err) reject(err);
            else callback(row);
          },
          (err: Error | null, count?: number) => {
            if (err) reject(err);
            else resolve(count || 0);
          }
        );
      });
    };

    promisifiedStmt.finalizeAsync = promisify(stmt.finalize).bind(stmt);

    return promisifiedStmt;
  }
  /**
   * Begin a transaction
   * @returns {Promise<QueryResult>}
   */
  beginTransaction(): Promise<QueryResult> {
    return this.run("BEGIN TRANSACTION");
  }

  /**
   * Commit a transaction
   * @returns {Promise<QueryResult>}
   */
  commit(): Promise<QueryResult> {
    return this.run("COMMIT");
  }

  /**
   * Rollback a transaction
   * @returns {Promise<QueryResult>}
   */
  rollback(): Promise<QueryResult> {
    return this.run("ROLLBACK");
  }

  /**
   * Execute a function within a transaction
   * @param {function} callback - Function to execute inside transaction
   * @returns {Promise<T>} - Return value of the callback
   */
  async transaction<T>(
    callback: (db: SQLiteManager) => Promise<T>
  ): Promise<T> {
    await this.beginTransaction();

    try {
      const result = await callback(this);
      await this.commit();
      return result;
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }

  /**
   * Create a table if it doesn't exist
   * @param {string} tableName - Name of the table
   * @param {TableSchema} schema - Map of column names to definitions
   * @returns {Promise<void>}
   */
  async createTableIfNotExists(
    tableName: string,
    schema: TableSchema
  ): Promise<void> {
    const columns = Object.entries(schema)
      .map(([name, definition]) => `${name} ${definition}`)
      .join(", ");

    return this.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${columns})`);
  }

  /**
   * Check if a table exists
   * @param {string} tableName - Name of the table
   * @returns {Promise<boolean>}
   */
  async tableExists(tableName: string): Promise<boolean> {
    const result = await this.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [tableName]
    );
    return !!result;
  }

  /**
   * Get information about table columns
   * @param {string} tableName - Name of the table
   * @returns {Promise<ColumnInfo[]>}
   */
  async getTableInfo(tableName: string): Promise<ColumnInfo[]> {
    return this.all<ColumnInfo>(`PRAGMA table_info(${tableName})`);
  }

  /**
   * Insert a record into a table
   * @param {string} tableName - Name of the table
   * @param {TableData} data - Map of column names to values
   * @returns {Promise<QueryResult>} - Object with lastID and changes
   */
  async insert(tableName: string, data: TableData): Promise<QueryResult> {
    const columns = Object.keys(data).join(", ");
    const placeholders = Object.keys(data)
      .map(() => "?")
      .join(", ");
    const values = Object.values(data);

    return this.run(
      `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`,
      values
    );
  }

  /**
   * Update records in a table
   * @param {string} tableName - Name of the table
   * @param {TableData} data - Map of column names to values
   * @param {string} whereClause - WHERE clause for update
   * @param {any[]} whereParams - Parameters for WHERE clause
   * @returns {Promise<QueryResult>} - Object with changes
   */
  async update(
    tableName: string,
    data: TableData,
    whereClause: string,
    whereParams: any[] = []
  ): Promise<QueryResult> {
    const setClauses = Object.keys(data)
      .map((key) => `${key} = ?`)
      .join(", ");
    const values = [...Object.values(data), ...whereParams];

    return this.run(
      `UPDATE ${tableName} SET ${setClauses} WHERE ${whereClause}`,
      values
    );
  }

  /**
   * Delete records from a table
   * @param {string} tableName - Name of the table
   * @param {string} whereClause - WHERE clause for deletion
   * @param {any[]} whereParams - Parameters for WHERE clause
   * @returns {Promise<QueryResult>} - Object with changes
   */
  async delete(
    tableName: string,
    whereClause: string,
    whereParams: any[] = []
  ): Promise<QueryResult> {
    return this.run(
      `DELETE FROM ${tableName} WHERE ${whereClause}`,
      whereParams
    );
  }

  /**
   * Get a count of records
   * @param {string} tableName - Name of the table
   * @param {string|null} whereClause - Optional WHERE clause
   * @param {any[]} whereParams - Parameters for WHERE clause
   * @returns {Promise<number>} - Record count
   */
  async count(
    tableName: string,
    whereClause: string | null = null,
    whereParams: any[] = []
  ): Promise<number> {
    const sql = whereClause
      ? `SELECT COUNT(*) as count FROM ${tableName} WHERE ${whereClause}`
      : `SELECT COUNT(*) as count FROM ${tableName}`;

    const result = await this.get<CountResult>(sql, whereParams);
    return result ? result.count : 0;
  }

  /**
   * Run migrations from a directory
   * @param {string} migrationsDir - Path to migrations directory
   * @returns {Promise<string[]>} - Applied migrations
   */
  async runMigrations(migrationsDir: string): Promise<string[]> {
    // Create migrations table if it doesn't exist
    await this.createTableIfNotExists("migrations", {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      name: "TEXT NOT NULL UNIQUE",
      applied_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
    });

    // Get applied migrations
    const appliedMigrations = await this.all<MigrationRecord>(
      "SELECT name FROM migrations"
    );
    const appliedNames = new Set(appliedMigrations.map((m) => m.name));

    // Read migration files
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const applied: string[] = [];

    // Apply each migration in a transaction
    for (const file of files) {
      if (appliedNames.has(file)) continue;

      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, "utf8");

      await this.transaction(async () => {
        await this.exec(sql);
        await this.insert("migrations", { name: file });
        applied.push(file);
      });
    }

    return applied;
  }

  /**
   * Ensure database connection is initialized
   * @private
   */
  private _ensureConnection(): void {
    if (!this.isInitialized || !this.db) {
      throw new Error("Database is not initialized. Call initialize() first.");
    }
  }
}

export default SQLiteManager;
