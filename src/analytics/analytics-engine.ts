import type {
  AnalyticsEvent,
  SequenceStats,
  ToolStats,
} from "../models/types.js";
import type { AnalyticsRepository, RoutingStatsRecord } from "../storage/analytics-repository.js";
import type { CapabilityRepository } from "../storage/capability-repository.js";

export interface AnalyticsOptions {
  enabled: boolean;
  retentionDays: number;
}

export interface AnalyticsSummary {
  enabled: boolean;
  serversTracked: number;
  capabilitiesIndexed: number;
  searches: number;
  searchesNoResult: number;
  searchConversions: number;
  executionsSucceeded: number;
  executionsFailed: number;
  successRate: number | null;
  sequencesLearned: number;
}

const DAY_MS = 86_400_000;

export class AnalyticsEngine {
  constructor(
    private readonly repository: AnalyticsRepository,
    private readonly capabilitiesRepo: CapabilityRepository,
    private readonly options: AnalyticsOptions,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  record(event: AnalyticsEvent): void {
    if (!this.enabled) return;
    this.repository.insertEvent({ ...event, timestamp: event.timestamp ?? this.now() });
  }

  recordExecution(input: {
    serverId: string;
    capabilityId: string;
    sessionId?: string;
    success: boolean;
    latencyMs?: number;
  }): void {
    if (!this.enabled) return;
    this.repository.insertEvent({
      type: "capability.executed",
      sessionId: input.sessionId,
      serverId: input.serverId,
      capabilityId: input.capabilityId,
      timestamp: this.now(),
    });
    this.repository.insertEvent({
      type: input.success ? "execution.succeeded" : "execution.failed",
      sessionId: input.sessionId,
      serverId: input.serverId,
      capabilityId: input.capabilityId,
      latencyMs: input.latencyMs,
      success: input.success,
      timestamp: this.now(),
    });
    this.repository.bumpRouting(
      input.capabilityId,
      { success: input.success, latencyMs: input.latencyMs },
      this.now(),
    );
  }

  getRoutingStats(capabilityIds?: string[]): Map<string, RoutingStatsRecord> {
    return this.repository.getRoutingStats(capabilityIds);
  }

  maxUsageCount(): number {
    return this.repository.maxUsageCount();
  }

  recordSequence(previousCapabilityId: string, nextCapabilityId: string): void {
    if (!this.enabled || previousCapabilityId === nextCapabilityId) return;
    this.repository.recordSequence(previousCapabilityId, nextCapabilityId, this.now());
  }

  predictNext(previousCapabilityId: string, limit = 5): Map<string, number> {
    const predictions = new Map<string, number>();
    if (!this.enabled || !previousCapabilityId) return predictions;
    for (const stat of this.repository.topNext(previousCapabilityId, limit)) {
      if (stat.probability > 0) predictions.set(stat.nextCapabilityId, stat.probability);
    }
    return predictions;
  }

  toolStats(limit?: number): ToolStats[] {
    const stats = [...this.repository.getRoutingStats().values()].sort(
      (a, b) => b.usageCount - a.usageCount || a.capabilityId.localeCompare(b.capabilityId),
    );
    const capped = typeof limit === "number" ? stats.slice(0, limit) : stats;
    return capped.map((record) => ({
      capabilityId: record.capabilityId,
      serverId: this.capabilitiesRepo.get(record.capabilityId)?.serverId ?? "",
      totalCalls: record.usageCount,
      successfulCalls: record.successCount,
      failedCalls: record.failureCount,
      avgLatencyMs: Math.round(record.avgLatencyMs),
      lastUsedAt: record.lastUsedAt,
      successRate: record.usageCount > 0 ? round4(record.successCount / record.usageCount) : 0,
    }));
  }

  sequenceStats(limit = 25): SequenceStats[] {
    const output: SequenceStats[] = [];
    const seen = new Set<string>();
    for (const capability of this.capabilitiesRepo.listAll()) {
      for (const stat of this.repository.topNext(capability.capabilityId, limit)) {
        const key = `${stat.previousCapabilityId}->${stat.nextCapabilityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(stat);
      }
    }
    return output.sort((a, b) => b.occurrences - a.occurrences).slice(0, limit);
  }

  eventCounts(): Map<string, number> {
    return this.repository.countsByType(0);
  }

  summary(): AnalyticsSummary {
    const counts = this.eventCounts();
    const succeeded = counts.get("execution.succeeded") ?? 0;
    const failed = counts.get("execution.failed") ?? 0;
    const totalExecutions = succeeded + failed;
    return {
      enabled: this.enabled,
      serversTracked: this.capabilitiesRepo.listAll().length > 0 ? new Set(this.capabilitiesRepo.listAll().map((c) => c.serverId)).size : 0,
      capabilitiesIndexed: this.capabilitiesRepo.count(),
      searches: counts.get("capability.searched") ?? 0,
      searchesNoResult: counts.get("search.no_result") ?? 0,
      searchConversions: counts.get("search.converted") ?? 0,
      executionsSucceeded: succeeded,
      executionsFailed: failed,
      successRate: totalExecutions > 0 ? round4(succeeded / totalExecutions) : null,
      sequencesLearned: this.repository.sequenceCount(),
    };
  }

  prune(): number {
    if (!this.enabled) return 0;
    return this.repository.pruneEvents(this.options.retentionDays, this.now());
  }

  reset(): void {
    this.repository.resetAnalytics();
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export const RETENTION_SWEEP_INTERVAL_MS = DAY_MS;
