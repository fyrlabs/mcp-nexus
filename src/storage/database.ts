import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { NexusError } from "../models/errors.js";
import { MIGRATIONS } from "./migrations.js";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

function openDatabase(path: string): DatabaseSync {
  try {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    return new DatabaseSync(path);
  } catch (error) {
    throw new NexusError("STORAGE_UNAVAILABLE", `Cannot open database at ${path}: ${String(error)}`, {
      details: { path },
      cause: error,
    });
  }
}

const STATEMENT_CACHE_LIMIT = 128;

export class Database {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(readonly path: string) {
    this.db = openDatabase(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  get schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version;").get() as { user_version: number } | undefined;
    return row?.user_version ?? 0;
  }

  migrate(): void {
    const current = this.schemaVersion;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.transaction(() => {
        this.db.exec(migration.up);
        this.db.exec(`PRAGMA user_version = ${migration.version};`);
      });
      this.statements.clear();
    }
  }

  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.db.prepare(sql);
    if (this.statements.size >= STATEMENT_CACHE_LIMIT) {
      const oldest = this.statements.keys().next().value;
      if (oldest !== undefined) this.statements.delete(oldest);
    }
    this.statements.set(sql, statement);
    return statement;
  }

  exec(sql: string): void {
    this.statements.clear();
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    return this.prepare(sql).run(...params) as RunResult;
  }

  get(sql: string, ...params: SqlValue[]): Record<string, SqlValue> | undefined {
    return this.prepare(sql).get(...params) as Record<string, SqlValue> | undefined;
  }

  all(sql: string, ...params: SqlValue[]): Record<string, SqlValue>[] {
    return this.prepare(sql).all(...params) as Record<string, SqlValue>[];
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // rollback after connection failure is best effort
      }
      throw error;
    }
  }

  close(): void {
    this.statements.clear();
    try {
      this.db.close();
    } catch {
      // double close must not throw
    }
  }
}
