import type { Capability } from "../models/types.js";
import { AVAILABILITY, SERVER_STATUSES } from "../models/types.js";
import type { Database, SqlValue } from "./database.js";

export interface ServerRecord {
  id: string;
  name: string;
  configHash: string;
  transport: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastStartedAt: number | null;
  lastConnectedAt: number | null;
}

export class ServerRepository {
  constructor(private readonly db: Database) {}

  ensureServer(id: string, name: string, configHash: string, transport = "stdio", now = Date.now()): void {
    const existing = this.get(id);
    if (!existing) {
      this.db.run(
        `INSERT INTO servers (id, name, config_hash, transport, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'registered', ?, ?)`,
        id,
        name,
        configHash,
        transport,
        now,
        now,
      );
      return;
    }
    this.db.run(
      `UPDATE servers SET name = ?, config_hash = ?, updated_at = ? WHERE id = ?`,
      name,
      configHash,
      now,
      id,
    );
  }

  setStatus(id: string, status: string, now = Date.now()): void {
    if (!SERVER_STATUSES.includes(status as never)) {
      throw new Error(`Unknown server status "${status}"`);
    }
    this.db.run(`UPDATE servers SET status = ?, updated_at = ? WHERE id = ?`, status, now, id);
  }

  markStarted(id: string, now = Date.now()): void {
    this.db.run(
      `UPDATE servers SET last_started_at = ?, status = 'starting', updated_at = ? WHERE id = ?`,
      now,
      now,
      id,
    );
  }

  markConnected(id: string, now = Date.now()): void {
    this.db.run(
      `UPDATE servers SET last_connected_at = ?, status = 'running', updated_at = ? WHERE id = ?`,
      now,
      now,
      id,
    );
  }

  get(id: string): ServerRecord | undefined {
    const row = this.db.get(`SELECT * FROM servers WHERE id = ?`, id);
    return row ? mapServerRow(row) : undefined;
  }

  list(): ServerRecord[] {
    return this.db.all(`SELECT * FROM servers ORDER BY id`).map(mapServerRow);
  }

  remove(id: string): void {
    this.db.run(`DELETE FROM servers WHERE id = ?`, id);
  }
}

function mapServerRow(row: Record<string, SqlValue>): ServerRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    configHash: String(row.config_hash ?? ""),
    transport: String(row.transport ?? "stdio"),
    status: String(row.status ?? "registered"),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    lastStartedAt: row.last_started_at === null || row.last_started_at === undefined ? null : Number(row.last_started_at),
    lastConnectedAt:
      row.last_connected_at === null || row.last_connected_at === undefined ? null : Number(row.last_connected_at),
  };
}

export function mapCapabilityRow(row: Record<string, SqlValue>): Capability {
  let metadata: Capability["metadata"] = { tags: [], keywords: [], risk: "unknown" };
  try {
    const parsed = JSON.parse(String(row.metadata_json ?? "{}")) as Partial<Capability["metadata"]>;
    metadata = {
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
      risk: (parsed.risk as Capability["metadata"]["risk"]) ?? "unknown",
    };
  } catch {
    // corrupt metadata falls back to defaults
  }
  let inputSchemaSummary: Record<string, unknown> = {};
  try {
    inputSchemaSummary = JSON.parse(String(row.input_schema_json ?? "{}")) as Record<string, unknown>;
  } catch {
    // keep empty schema
  }
  const availability = String(row.availability ?? "unknown");
  return {
    capabilityId: String(row.capability_id),
    serverId: String(row.server_id),
    toolName: String(row.tool_name),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    inputSchemaSummary,
    metadata,
    availability: AVAILABILITY.includes(availability as never) ? (availability as Capability["availability"]) : "unknown",
    updatedAt: Number(row.updated_at ?? 0),
  };
}
