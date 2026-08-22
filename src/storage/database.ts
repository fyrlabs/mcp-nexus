import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

export class Database {
  private readonly db: DatabaseSync;

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
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    return this.db.prepare(sql).run(...params) as RunResult;
  }

  get(sql: string, ...params: SqlValue[]): Record<string, SqlValue> | undefined {
    return this.db.prepare(sql).get(...params) as Record<string, SqlValue> | undefined;
  }

  all(sql: string, ...params: SqlValue[]): Record<string, SqlValue>[] {
    return this.db.prepare(sql).all(...params) as Record<string, SqlValue>[];
  }

  transaction<T>(fn: () => T): T {
    this.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.exec("ROLLBACK;");
      } catch {
        // rollback after connection failure is best effort
      }
      throw error;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // double close must not throw
    }
  }
}
