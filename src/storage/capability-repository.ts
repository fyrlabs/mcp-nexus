import type { Capability } from "../models/types.js";
import type { Database } from "./database.js";
import { mapCapabilityRow } from "./server-repository.js";

export class CapabilityRepository {
  constructor(private readonly db: Database) {}

  replaceServerCapabilities(serverId: string, capabilities: Capability[], now = Date.now()): number {
    return this.db.transaction(() => {
      this.db.run(`DELETE FROM capabilities WHERE server_id = ?`, serverId);
      for (const capability of capabilities) {
        this.insert(capability, now);
      }
      return capabilities.length;
    });
  }

  insert(capability: Capability, now = Date.now()): void {
    this.db.run(
      `INSERT INTO capabilities (
        capability_id, server_id, tool_name, title, description,
        input_schema_json, metadata_json, schema_hash, risk_level, availability,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(capability_id) DO UPDATE SET
        tool_name = excluded.tool_name,
        title = excluded.title,
        description = excluded.description,
        input_schema_json = excluded.input_schema_json,
        metadata_json = excluded.metadata_json,
        schema_hash = excluded.schema_hash,
        risk_level = excluded.risk_level,
        availability = excluded.availability,
        updated_at = excluded.updated_at`,
      capability.capabilityId,
      capability.serverId,
      capability.toolName,
      capability.title,
      capability.description,
      JSON.stringify(capability.inputSchemaSummary ?? {}),
      JSON.stringify(capability.metadata),
      schemaHashOf(capability),
      capability.metadata.risk,
      capability.availability,
      now,
      now,
    );
  }

  get(capabilityId: string): Capability | undefined {
    const row = this.db.get(`SELECT * FROM capabilities WHERE capability_id = ?`, capabilityId);
    return row ? mapCapabilityRow(row) : undefined;
  }

  getByTool(serverId: string, toolName: string): Capability | undefined {
    const row = this.db.get(
      `SELECT * FROM capabilities WHERE server_id = ? AND tool_name = ?`,
      serverId,
      toolName,
    );
    return row ? mapCapabilityRow(row) : undefined;
  }

  listByServer(serverId: string): Capability[] {
    return this.db
      .all(`SELECT * FROM capabilities WHERE server_id = ? ORDER BY capability_id`, serverId)
      .map(mapCapabilityRow);
  }

  listAll(): Capability[] {
    return this.db.all(`SELECT * FROM capabilities ORDER BY capability_id`).map(mapCapabilityRow);
  }

  count(): number {
    const row = this.db.get(`SELECT COUNT(*) AS n FROM capabilities`);
    return Number(row?.n ?? 0);
  }

  countForServer(serverId: string): number {
    const row = this.db.get(`SELECT COUNT(*) AS n FROM capabilities WHERE server_id = ?`, serverId);
    return Number(row?.n ?? 0);
  }

  setAvailability(capabilityIds: string[], availability: Capability["availability"], now = Date.now()): void {
    if (capabilityIds.length === 0) return;
    const placeholders = capabilityIds.map(() => "?").join(",");
    this.db.run(
      `UPDATE capabilities SET availability = ?, updated_at = ? WHERE capability_id IN (${placeholders})`,
      availability,
      now,
      ...capabilityIds,
    );
  }

  removeServer(serverId: string): void {
    this.db.run(`DELETE FROM capabilities WHERE server_id = ?`, serverId);
  }
}

export function schemaHashOf(capability: Pick<Capability, "inputSchemaSummary">): string {
  const stable = JSON.stringify(sortKeysDeep(capability.inputSchemaSummary ?? {}));
  let hash = 5381;
  for (let i = 0; i < stable.length; i++) {
    hash = ((hash << 5) + hash + stable.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries) output[key] = sortKeysDeep(item);
    return output;
  }
  return value;
}
