import type { Database } from "./database.js";

export interface EmbeddingCacheEntry {
  capabilityId: string;
  provider: string;
  model: string;
  dims: number;
  vector: Float32Array;
}

export class EmbeddingCacheRepository {
  constructor(private readonly db: Database) {}

  loadAll(provider: string, model: string): Map<string, { vector: Float32Array; contentHash: string }> {
    const rows = this.db.all(
      `SELECT capability_id, vector, dims, content_hash FROM capability_embeddings WHERE provider = ? AND model = ?`,
      provider,
      model,
    );
    const map = new Map<string, { vector: Float32Array; contentHash: string }>();
    for (const row of rows) {
      const blob = row.vector;
      if (!(blob instanceof Uint8Array)) continue;
      const dims = Number(row.dims ?? 0);
      if (dims <= 0 || blob.byteLength !== dims * 4) continue;
      map.set(String(row.capability_id), {
        vector: new Float32Array(blob.buffer, blob.byteOffset, dims),
        contentHash: String(row.content_hash ?? ""),
      });
    }
    return map;
  }

  store(
    entries: Map<string, { provider: string; model: string; contentHash: string; vector: Float32Array }>,
    now = Date.now(),
  ): void {
    if (entries.size === 0) return;
    this.db.transaction(() => {
      for (const [capabilityId, entry] of entries) {
        this.db.run(
          `INSERT INTO capability_embeddings (capability_id, provider, model, dims, vector, content_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(capability_id) DO UPDATE SET
             provider = excluded.provider,
             model = excluded.model,
             dims = excluded.dims,
             vector = excluded.vector,
             content_hash = excluded.content_hash,
             updated_at = excluded.updated_at`,
          capabilityId,
          entry.provider,
          entry.model,
          entry.vector.length,
          new Uint8Array(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength),
          entry.contentHash,
          now,
        );
      }
    });
  }

  clear(provider?: string): number {
    if (provider) {
      return Number(this.db.run(`DELETE FROM capability_embeddings WHERE provider = ?`, provider).changes);
    }
    return Number(this.db.run(`DELETE FROM capability_embeddings`).changes);
  }

  count(): number {
    const row = this.db.get(`SELECT COUNT(*) AS n FROM capability_embeddings`);
    return Number(row?.n ?? 0);
  }
}
