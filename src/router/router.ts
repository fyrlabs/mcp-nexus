import type { CapabilityIndex } from "../index/capability-index.js";
import type { LifecycleManager } from "../lifecycle/lifecycle-manager.js";
import type { PolicyEngine } from "./policies.js";
import type { Ranker, UsageSignals } from "./ranker.js";
import type { Predictor } from "./predictor.js";
import type { AnalyticsEngine } from "../analytics/analytics-engine.js";
import type {
  Capability,
  CapabilityMatch,
  ExecutionContext,
  RoutingContext,
} from "../models/types.js";
import type { RoutingConfig } from "../config/schema.js";
import { NexusError, capabilityNotFound } from "../models/errors.js";
import type { Logger } from "../utils/logger.js";

interface SessionState {
  lastCapabilityId: string | null;
  lastSearchedAt: number | null;
  pendingConversion: boolean;
}

const MAX_SESSIONS = 512;

export interface RouterOptions {
  autoIndexMissing?: boolean;
}

export class Router {
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly index: CapabilityIndex,
    private readonly lifecycle: LifecycleManager,
    private readonly policies: PolicyEngine,
    private readonly ranker: Ranker,
    private readonly predictor: Predictor,
    private readonly analytics: AnalyticsEngine,
    private readonly routing: RoutingConfig,
    private readonly logger: Logger,
    private readonly options: RouterOptions = {},
    private readonly now: () => number = Date.now,
  ) {}

  async search(query: string, context: RoutingContext = {}): Promise<CapabilityMatch[]> {
    const sessionId = context.sessionId ?? "default";
    const limit = context.limit ?? this.routing.limit;
    const baseMatches = await this.index.search(query, {
      limit: limit * 2,
      serverIds: context.serverIds,
    });
    const statsByCapability = this.analytics.getRoutingStats(
      baseMatches.map((base) => base.capabilityId),
    );
    const maxGlobalUsage = this.analytics.maxUsageCount();
    const predictions = this.predictor.predictNext(this.session(sessionId).lastCapabilityId);

    const ranked: CapabilityMatch[] = [];
    for (const base of baseMatches) {
      const decision = this.policies.evaluate(base.capabilityId, base.serverId, base.risk);
      if (!decision.allowed) continue;
      const match = this.policies.annotate(base);
      const usageStats = statsByCapability.get(match.capabilityId);
      const signalsBase: UsageSignals = {
        usageCount: usageStats?.usageCount ?? 0,
        lastUsedAt: usageStats?.lastUsedAt ?? null,
        successRate: usageStats?.successRate ?? 0,
        globalShare:
          maxGlobalUsage > 0 ? (usageStats?.usageCount ?? 0) / maxGlobalUsage : 0,
        sequenceProbability: predictions.get(match.capabilityId) ?? 0,
      };
      const pin = this.policies.isPinned(match.capabilityId) || this.policies.isServerPinned(match.serverId);
      const signals: UsageSignals & { pin: number } = { ...signalsBase, pin: pin ? 1 : 0 };
      ranked.push(
        this.ranker.rank(match, signals, {
          now: context.now ?? this.now(),
        }),
      );
    }

    ranked.sort((a, b) => b.score - a.score || a.capabilityId.localeCompare(b.capabilityId));
    const results = ranked.slice(0, limit);

    const state = this.session(sessionId);
    state.lastSearchedAt = this.now();
    state.pendingConversion = results.length > 0;

    this.analytics.record({
      type: "capability.searched",
      sessionId: context.sessionId,
      query,
    });
    if (results.length === 0) {
      this.analytics.record({ type: "search.no_result", sessionId: context.sessionId, query });
    }
    return results;
  }

  async describe(capabilityIds: string[], context: RoutingContext = {}): Promise<{ found: Capability[]; missing: string[] }> {
    const initial = this.index.describe(capabilityIds);
    let result = initial;
    if (initial.missing.length > 0 && (this.options.autoIndexMissing ?? true)) {
      const candidateServerIds = [
        ...new Set(initial.missing.map((id) => this.resolveServerId(id))),
      ];
      try {
        await this.index.ensureIndexed({ serverIds: candidateServerIds });
        const retry = this.index.describe(initial.missing);
        result = {
          found: [...initial.found, ...retry.found],
          missing: retry.missing,
        };
      } catch (error) {
        this.logger.warn("lazy indexing during describe failed", { error: String(error) });
      }
    }
    const allowed: Capability[] = [];
    const blocked: string[] = [];
    for (const capability of result.found) {
      const decision = this.policies.evaluate(
        capability.capabilityId,
        capability.serverId,
        capability.metadata.risk,
      );
      if (decision.allowed) allowed.push(capability);
      else blocked.push(capability.capabilityId);
    }
    result = { found: allowed, missing: [...result.missing, ...blocked] };

    for (const capability of result.found) {
      this.analytics.record({
        type: "capability.described",
        sessionId: context.sessionId,
        serverId: capability.serverId,
        capabilityId: capability.capabilityId,
      });
    }
    return result;
  }

  async execute(capabilityId: string, args: unknown, context: ExecutionContext = {}): Promise<unknown> {
    const startedAt = this.now();
    const sessionId = context.sessionId ?? "default";
    const state = this.session(sessionId);

    const capability = await this.resolveCapability(capabilityId);
    const decision = this.policies.evaluate(capability.capabilityId, capability.serverId, capability.metadata.risk);
    if (!decision.allowed) {
      throw new NexusError("PERMISSION_DENIED", `Execution blocked: ${decision.reason}`, {
        details: { capabilityId, reason: decision.reason },
      });
    }

    const predictionsBefore = this.predictor.predictNext(state.lastCapabilityId);
    if (predictionsBefore.has(capability.capabilityId)) {
      this.analytics.record({
        type: "prediction.used",
        sessionId: context.sessionId,
        capabilityId,
      });
    }
    if (state.pendingConversion) {
      this.analytics.record({
        type: "search.converted",
        sessionId: context.sessionId,
        capabilityId,
      });
      state.pendingConversion = false;
    }
    this.analytics.record({
      type: "capability.selected",
      sessionId: context.sessionId,
      serverId: capability.serverId,
      capabilityId,
    });

    try {
      const result = await this.lifecycle.callTool(
        capability.serverId,
        capability.toolName,
        (args ?? {}) as Record<string, unknown>,
      );
      const latencyMs = this.now() - startedAt;
      this.index.markAvailable(capability.serverId);
      this.analytics.recordExecution({
        serverId: capability.serverId,
        capabilityId,
        sessionId: context.sessionId,
        success: true,
        latencyMs,
      });
      this.predictor.recordTransition(state.lastCapabilityId, capabilityId);
      state.lastCapabilityId = capabilityId;
      this.prefetchLikelyNext(state.lastCapabilityId);
      return result;
    } catch (error) {
      const latencyMs = this.now() - startedAt;
      const nexusError = toExecutionError(capability, error);
      const isLifecycleFailure =
        nexusError.code === "MCP_START_FAILED" ||
        nexusError.code === "MCP_CONNECTION_FAILED" ||
        nexusError.code === "TIMEOUT" ||
        nexusError.code === "MCP_QUARANTINED";
      if (isLifecycleFailure) this.index.markUnavailable(capability.serverId);
      this.analytics.recordExecution({
        serverId: capability.serverId,
        capabilityId,
        sessionId: context.sessionId,
        success: false,
        latencyMs,
      });
      throw nexusError;
    }
  }

  async searchServers(
    query: string,
    context: RoutingContext = {},
  ): Promise<Array<{ serverId: string; score: number; topCapabilities: string[] }>> {
    const matches = await this.search(query, { ...context, limit: 100 });
    const byServer = new Map<string, { score: number; topCapabilities: string[] }>();
    for (const match of matches) {
      const existing = byServer.get(match.serverId);
      if (!existing) {
        byServer.set(match.serverId, { score: match.score, topCapabilities: [match.capabilityId] });
        continue;
      }
      existing.topCapabilities.push(match.capabilityId);
      if (match.score > existing.score) existing.score = match.score;
    }
    return [...byServer.entries()]
      .map(([serverId, value]) => ({ serverId, ...value }))
      .sort((a, b) => b.score - a.score || a.serverId.localeCompare(b.serverId));
  }

  private resolveServerId(capabilityId: string): string {
    return (
      this.index.serverIdOf(capabilityId) ??
      this.index.configuredServerIdFor(capabilityId) ??
      serverPartOf(capabilityId)
    );
  }

  private prefetchLikelyNext(lastCapabilityId: string | null): void {
    if (!this.routing.prefetch || !lastCapabilityId) return;
    const predictions = this.predictor.predictNext(lastCapabilityId);
    const top = [...predictions.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] < PREFETCH_PROBABILITY_THRESHOLD) return;
    const serverId = this.resolveServerId(top[0]);
    if (!serverId) return;
    void this.lifecycle.ensureStarted(serverId).catch(() => undefined);
  }

  private async resolveCapability(capabilityId: string): Promise<Capability> {
    const existing = this.index.get(capabilityId);
    if (existing) return existing;
    if ((this.options.autoIndexMissing ?? true)) {
      await this.index.ensureIndexed({ serverIds: [this.resolveServerId(capabilityId)] }).catch(() => undefined);
    }
    const capability = this.index.get(capabilityId);
    if (!capability) throw capabilityNotFound(capabilityId);
    return capability;
  }

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { lastCapabilityId: null, lastSearchedAt: null, pendingConversion: false };
      this.evictSessionsIfNeeded(sessionId);
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private evictSessionsIfNeeded(incomingId: string): void {
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined || oldest === incomingId) break;
      this.sessions.delete(oldest);
    }
  }
}

function toExecutionError(capability: Capability, error: unknown): NexusError {
  if (error instanceof NexusError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NexusError("TOOL_EXECUTION_FAILED", `Tool "${capability.toolName}" failed: ${message}`, {
    details: { capabilityId: capability.capabilityId, serverId: capability.serverId },
    cause: error,
  });
}

const PREFETCH_PROBABILITY_THRESHOLD = 0.5;

function serverPartOf(capabilityId: string): string {
  return capabilityId.split(".")[0] ?? capabilityId;
}

