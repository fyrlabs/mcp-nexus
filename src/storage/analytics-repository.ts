import type { AnalyticsEvent, SequenceStats } from "../models/types.js";
import type { Database } from "./database.js";

export interface RoutingStatsRecord {
  capabilityId: string;
  usageCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgLatencyMs: number;
  lastUsedAt: number | null;
}

export interface EventCounts {
  eventType: string;
  count: number;
}

const MS_PER_DAY = 86_400_000;

export class AnalyticsRepository {
  constructor(private readonly db: Database) {}

  insertEvent(event: AnalyticsEvent): void {
    this.db.run(
      `INSERT INTO usage_events (timestamp, session_id, server_id, capability_id, event_type, latency_ms, success, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      event.timestamp ?? Date.now(),
      event.sessionId ?? null,
      event.serverId ?? null,
      event.capabilityId ?? null,
      event.type,
      event.latencyMs ?? null,
      event.success === undefined ? null : event.success ? 1 : 0,
      event.source ?? null,
    );
  }

  countsByType(sinceTimestamp = 0): Map<string, number> {
    const rows = this.db.all(
      `SELECT event_type, COUNT(*) AS n FROM usage_events WHERE timestamp >= ? GROUP BY event_type`,
      sinceTimestamp,
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(String(row.event_type), Number(row.n));
    }
    return counts;
  }

  pruneEvents(retentionDays: number, now = Date.now()): number {
    const cutoff = now - retentionDays * MS_PER_DAY;
    return Number(this.db.run(`DELETE FROM usage_events WHERE timestamp < ?`, cutoff).changes);
  }

  bumpRouting(
    capabilityId: string,
    outcome: { success: boolean; latencyMs?: number },
    now = Date.now(),
  ): void {
    this.db.transaction(() => this.bumpRoutingInner(capabilityId, outcome, now));
  }

  private bumpRoutingInner(
    capabilityId: string,
    outcome: { success: boolean; latencyMs?: number },
    now: number,
  ): void {
    const existing = this.getRoutingStats([capabilityId]).get(capabilityId);
    if (!existing) {
      const latency = outcome.latencyMs ?? 0;
      this.db.run(
        `INSERT INTO routing_stats (
          capability_id, usage_count, success_count, failure_count, success_rate, avg_latency_ms, last_used_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
        capabilityId,
        outcome.success ? 1 : 0,
        outcome.success ? 0 : 1,
        outcome.success ? 1 : 0,
        latency ?? null,
        now,
        now,
      );
      return;
    }
    const usageCount = existing.usageCount + 1;
    const successCount = existing.successCount + (outcome.success ? 1 : 0);
    const failureCount = existing.failureCount + (outcome.success ? 0 : 1);
    let avgLatency = existing.avgLatencyMs;
    if (outcome.latencyMs !== undefined && outcome.latencyMs !== null) {
      avgLatency = existing.avgLatencyMs + (outcome.latencyMs - existing.avgLatencyMs) / usageCount;
    }
    this.db.run(
      `UPDATE routing_stats
       SET usage_count = ?, success_count = ?, failure_count = ?, success_rate = ?, avg_latency_ms = ?, last_used_at = ?, updated_at = ?
       WHERE capability_id = ?`,
      usageCount,
      successCount,
      failureCount,
      successCount / usageCount,
      avgLatency,
      now,
      now,
      capabilityId,
    );
  }

  getRoutingStats(capabilityIds?: string[]): Map<string, RoutingStatsRecord> {
    const rows =
      capabilityIds && capabilityIds.length > 0
        ? this.db.all(
            `SELECT * FROM routing_stats WHERE capability_id IN (${capabilityIds.map(() => "?").join(",")})`,
            ...capabilityIds,
          )
        : this.db.all(`SELECT * FROM routing_stats`);
    const map = new Map<string, RoutingStatsRecord>();
    for (const row of rows) {
      map.set(String(row.capability_id), {
        capabilityId: String(row.capability_id),
        usageCount: Number(row.usage_count ?? 0),
        successCount: Number(row.success_count ?? 0),
        failureCount: Number(row.failure_count ?? 0),
        successRate: Number(row.success_rate ?? 0),
        avgLatencyMs: Number(row.avg_latency_ms ?? 0),
        lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
      });
    }
    return map;
  }

  setPredictionScores(scores: Map<string, number>, now = Date.now()): void {
    if (scores.size === 0) return;
    this.db.transaction(() => {
      for (const [capabilityId, score] of scores) {
        this.db.run(
          `UPDATE routing_stats SET prediction_score = ?, updated_at = ? WHERE capability_id = ?`,
          score,
          now,
          capabilityId,
        );
      }
    });
  }

  recordSequence(previousCapabilityId: string, nextCapabilityId: string, now = Date.now()): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO tool_sequences (previous_capability_id, next_capability_id, occurrences, probability, updated_at)
         VALUES (?, ?, 1, 1.0, ?)
         ON CONFLICT(previous_capability_id, next_capability_id) DO UPDATE SET
           occurrences = occurrences + 1,
           updated_at = excluded.updated_at`,
        previousCapabilityId,
        nextCapabilityId,
        now,
      );
      this.renormalizeSequence(previousCapabilityId);
    });
  }

  private renormalizeSequence(previousCapabilityId: string): void {
    this.db.run(
      `UPDATE tool_sequences
       SET probability = occurrences * 1.0 / MAX(1, (
             SELECT SUM(occurrences) FROM tool_sequences WHERE previous_capability_id = ?
           ))
       WHERE previous_capability_id = ?`,
      previousCapabilityId,
      previousCapabilityId,
    );
  }

  topNext(previousCapabilityId: string, limit = 5): SequenceStats[] {
    return this.db
      .all(
        `SELECT next_capability_id AS id, occurrences AS n, probability AS p
         FROM tool_sequences
         WHERE previous_capability_id = ?
         ORDER BY occurrences DESC, next_capability_id ASC
         LIMIT ?`,
        previousCapabilityId,
        limit,
      )
      .map((row) => ({
        previousCapabilityId,
        nextCapabilityId: String(row.id),
        occurrences: Number(row.n),
        probability: Number(row.p),
      }));
  }

  sequenceCount(): number {
    const row = this.db.get(`SELECT COUNT(*) AS n FROM tool_sequences`);
    return Number(row?.n ?? 0);
  }

  resetAnalytics(): void {
    this.db.transaction(() => {
      this.db.run(`DELETE FROM usage_events`);
      this.db.run(`DELETE FROM routing_stats`);
      this.db.run(`DELETE FROM tool_sequences`);
    });
  }
}
