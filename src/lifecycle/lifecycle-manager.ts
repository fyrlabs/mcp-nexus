import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NexusError, mcpNotFound, mcpQuarantined } from "../models/errors.js";
import type { MCPServerDefinition, ServerStatus } from "../models/types.js";
import { DownstreamClient, NEXUS_CLIENT_NAME } from "../mcp/downstream-client.js";
import type { TransportFactory } from "../mcp/transport-factory.js";
import { withTimeout } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";

export interface LifecycleTimeouts {
  startupTimeoutMs: number;
  callTimeoutMs: number;
  indexTimeoutMs: number;
  hotIdleTimeoutMs: number;
  warmIdleTimeoutMs: number;
  coldIdleTimeoutMs: number;
}

export const DEFAULT_TIMEOUTS: LifecycleTimeouts = {
  startupTimeoutMs: 20_000,
  callTimeoutMs: 120_000,
  indexTimeoutMs: 30_000,
  hotIdleTimeoutMs: 15 * 60_000,
  warmIdleTimeoutMs: 5 * 60_000,
  coldIdleTimeoutMs: 60_000,
};

export interface QuarantinePolicy {
  failureThreshold: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_QUARANTINE: QuarantinePolicy = {
  failureThreshold: 3,
  backoffMs: 30_000,
  maxBackoffMs: 300_000,
};

export interface ServerHealth {
  serverId: string;
  consecutiveFailures: number;
  quarantinedUntil: number | null;
  lastFailureAt: number | null;
  lastFailureCode: string | null;
  quarantined: boolean;
  score: number;
}

export interface ServerCatalog {
  get(serverId: string): MCPServerDefinition | undefined;
  ids(): string[];
}

export interface LifecycleEvents {
  onStarted?: (serverId: string) => void;
  onStopped?: (serverId: string) => void;
  onStartFailed?: (serverId: string, error: NexusError) => void;
  onHealthChanged?: (serverId: string, health: ServerHealth) => void;
}

export interface ManagedStatus {
  serverId: string;
  status: ServerStatus;
  lastUsedAt: number | null;
}

interface HealthState {
  consecutiveFailures: number;
  quarantinedUntil: number | null;
  lastFailureAt: number | null;
  lastFailureCode: string | null;
}

interface RunningServer {
  definition: MCPServerDefinition;
  client: DownstreamClient;
  lastUsedAt: number;
  status: ServerStatus;
}

export const HOT_USAGE_THRESHOLD = 10;
export const WARM_USAGE_THRESHOLD = 2;

export class LifecycleManager {
  private readonly running = new Map<string, RunningServer>();
  private readonly pending = new Map<string, Promise<RunningServer>>();
  private readonly inflightCalls = new Map<string, number>();
  private readonly healthState = new Map<string, HealthState>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly catalog: ServerCatalog,
    private readonly transportFactory: TransportFactory,
    private readonly clientVersion: string,
    private readonly timeouts: LifecycleTimeouts,
    private readonly logger: Logger,
    private readonly events: LifecycleEvents = {},
    private readonly usageForServer: (serverId: string) => number = () => 0,
    private readonly now: () => number = Date.now,
    private readonly quarantine: QuarantinePolicy = DEFAULT_QUARANTINE,
  ) {}

  startSweeper(intervalMs = 15_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle().catch((error) => {
        this.logger.error("idle sweep failed", { error: String(error) });
      });
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async ensureStarted(serverId: string): Promise<DownstreamClient> {
    const existing = this.running.get(serverId);
    if (existing && existing.client.connected) {
      existing.lastUsedAt = this.now();
      return existing.client;
    }
    if (existing && !existing.client.connected) {
      this.running.delete(serverId);
    }
    const pendingStart = this.pending.get(serverId);
    if (pendingStart) return (await pendingStart).client;

    const startPromise = this.start(serverId);
    this.pending.set(serverId, startPromise);
    try {
      return (await startPromise).client;
    } finally {
      this.pending.delete(serverId);
    }
  }

  async listTools(serverId: string, timeoutMs = this.timeouts.indexTimeoutMs): Promise<Tool[]> {
    const client = await this.ensureStarted(serverId);
    return client.listTools(timeoutMs);
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    timeoutMs = this.timeouts.callTimeoutMs,
  ): Promise<unknown> {
    const client = await this.ensureStarted(serverId);
    this.inflightCalls.set(serverId, (this.inflightCalls.get(serverId) ?? 0) + 1);
    try {
      return await client.callTool(toolName, args, timeoutMs);
    } finally {
      const current = this.inflightCalls.get(serverId) ?? 0;
      if (current <= 1) this.inflightCalls.delete(serverId);
      else this.inflightCalls.set(serverId, current - 1);
    }
  }

  async stop(serverId: string): Promise<void> {
    const managed = this.running.get(serverId);
    if (!managed) return;
    this.running.delete(serverId);
    managed.status = "stopped";
    await managed.client.close();
    this.events.onStopped?.(serverId);
  }

  async stopAll(): Promise<void> {
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.stop(id).catch(() => undefined)));
  }

  status(serverId: string): ServerStatus {
    return this.running.get(serverId)?.status ?? "not_started";
  }

  isRunning(serverId: string): boolean {
    const managed = this.running.get(serverId);
    return managed !== undefined && managed.client.connected;
  }

  statuses(): ManagedStatus[] {
    return [...this.running.values()].map((managed) => ({
      serverId: managed.definition.id,
      status: managed.status,
      lastUsedAt: managed.lastUsedAt,
    }));
  }

  runningCount(): number {
    let count = 0;
    for (const managed of this.running.values()) {
      if (managed.client.connected) count++;
    }
    return count;
  }

  isQuarantined(serverId: string): boolean {
    const until = this.healthState.get(serverId)?.quarantinedUntil ?? null;
    return until !== null && this.now() < until;
  }

  quarantineRetryMs(serverId: string): number {
    const until = this.healthState.get(serverId)?.quarantinedUntil ?? null;
    if (until === null) return 0;
    return Math.max(0, until - this.now());
  }

  health(serverId: string): ServerHealth {
    return this.toHealth(serverId, this.healthState.get(serverId) ?? emptyHealthState());
  }

  healthAll(): ServerHealth[] {
    const ids = new Set([...this.catalog.ids(), ...this.healthState.keys()]);
    return [...ids].sort().map((id) => this.health(id));
  }

  restoreHealth(serverId: string, state: HealthState): void {
    this.healthState.set(serverId, {
      consecutiveFailures: Math.max(0, state.consecutiveFailures),
      quarantinedUntil: state.quarantinedUntil,
      lastFailureAt: state.lastFailureAt,
      lastFailureCode: state.lastFailureCode,
    });
  }

  clearQuarantine(serverId: string): void {
    const state = this.healthState.get(serverId);
    if (!state || (state.consecutiveFailures === 0 && state.quarantinedUntil === null)) return;
    state.consecutiveFailures = 0;
    state.quarantinedUntil = null;
    this.events.onHealthChanged?.(serverId, this.toHealth(serverId, state));
  }

  async startAlwaysOnServers(): Promise<string[]> {
    const started: string[] = [];
    for (const id of this.catalog.ids()) {
      const definition = this.catalog.get(id);
      if (!definition?.enabled || !definition.alwaysOn) continue;
      try {
        await this.ensureStarted(id);
        started.push(id);
      } catch (error) {
        this.logger.warn("always-on server failed to start", {
          serverId: id,
          code: error instanceof NexusError ? error.code : "UNKNOWN",
        });
      }
    }
    return started;
  }

  private async start(serverId: string): Promise<RunningServer> {
    const definition = this.catalog.get(serverId);
    if (!definition) throw mcpNotFound(serverId);
    if (!definition.enabled) {
      throw new NexusError("PERMISSION_DENIED", `MCP server "${serverId}" is disabled`, { details: { serverId } });
    }
    if (this.isQuarantined(serverId)) {
      throw mcpQuarantined(serverId, this.quarantineRetryMs(serverId));
    }
    const managed: RunningServer = {
      definition,
      client: new DownstreamClient(
        definition,
        this.transportFactory,
        { name: NEXUS_CLIENT_NAME, version: this.clientVersion },
        {
          callTimeoutMs: this.timeouts.callTimeoutMs,
          onDisconnect: () => this.handleUnexpectedDisconnect(serverId),
        },
      ),
      lastUsedAt: this.now(),
      status: "starting",
    };
    this.running.set(serverId, managed);
    try {
      await withTimeout(managed.client.connect(), this.timeouts.startupTimeoutMs, `MCP "${serverId}" startup`);
      managed.status = "running";
      managed.lastUsedAt = this.now();
      this.clearQuarantine(serverId);
      this.events.onStarted?.(serverId);
      this.logger.debug("downstream server started", { serverId });
      return managed;
    } catch (error) {
      this.running.delete(serverId);
      await managed.client.close().catch(() => undefined);
      const nexusError = toLifecycleError(serverId, error);
      managed.status = "failed";
      this.recordFailure(serverId, nexusError.code);
      this.events.onStartFailed?.(serverId, nexusError);
      this.logger.warn("downstream server failed to start", { serverId, code: nexusError.code });
      throw nexusError;
    }
  }

  private handleUnexpectedDisconnect(serverId: string): void {
    const managed = this.running.get(serverId);
    if (!managed) return;
    this.running.delete(serverId);
    managed.status = "stopped";
    this.recordFailure(serverId, "MCP_CONNECTION_FAILED");
    this.events.onStopped?.(serverId);
  }

  private recordFailure(serverId: string, code: string): void {
    const state = this.healthState.get(serverId) ?? emptyHealthState();
    this.healthState.set(serverId, state);
    state.consecutiveFailures += 1;
    state.lastFailureAt = this.now();
    state.lastFailureCode = code;
    const { failureThreshold, backoffMs, maxBackoffMs } = this.quarantine;
    if (failureThreshold > 0 && state.consecutiveFailures >= failureThreshold) {
      const backoff = Math.min(backoffMs * 2 ** (state.consecutiveFailures - failureThreshold), maxBackoffMs);
      state.quarantinedUntil = this.now() + backoff;
      this.logger.warn("server quarantined after repeated failures", {
        serverId,
        consecutiveFailures: state.consecutiveFailures,
        retryInMs: backoff,
        code,
      });
    }
    this.events.onHealthChanged?.(serverId, this.toHealth(serverId, state));
  }

  private toHealth(serverId: string, state: HealthState): ServerHealth {
    const quarantined = state.quarantinedUntil !== null && this.now() < state.quarantinedUntil;
    const threshold = this.quarantine.failureThreshold;
    const score = quarantined
      ? 0
      : threshold > 0
        ? Math.max(0, 1 - state.consecutiveFailures / threshold)
        : state.consecutiveFailures === 0
          ? 1
          : 0;
    return {
      serverId,
      consecutiveFailures: state.consecutiveFailures,
      quarantinedUntil: state.quarantinedUntil,
      lastFailureAt: state.lastFailureAt,
      lastFailureCode: state.lastFailureCode,
      quarantined,
      score,
    };
  }

  private async sweepIdle(): Promise<void> {
    const current = this.now();
    for (const [serverId, managed] of this.running) {
      if ((this.inflightCalls.get(serverId) ?? 0) > 0) continue;
      const idleMs = current - managed.lastUsedAt;
      const limit = this.idleLimitFor(serverId);
      if (limit === 0 || idleMs < limit) continue;
      this.logger.info("stopping idle downstream server", { serverId, idleMs, limit });
      await this.stop(serverId).catch(() => undefined);
    }
  }

  private idleLimitFor(serverId: string): number {
    const usage = this.usageForServer(serverId);
    if (usage >= HOT_USAGE_THRESHOLD) return this.timeouts.hotIdleTimeoutMs;
    if (usage >= WARM_USAGE_THRESHOLD) return this.timeouts.warmIdleTimeoutMs;
    return this.timeouts.coldIdleTimeoutMs;
  }
  async dispose(): Promise<void> {
    this.stopSweeper();
    await this.stopAll();
  }
}

function emptyHealthState(): HealthState {
  return { consecutiveFailures: 0, quarantinedUntil: null, lastFailureAt: null, lastFailureCode: null };
}

function toLifecycleError(serverId: string, error: unknown): NexusError {
  if (error instanceof NexusError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = /ENOENT|EACCES|spawn/i.test(message)
    ? ("MCP_START_FAILED" as const)
    : /timed out/i.test(message)
      ? ("TIMEOUT" as const)
      : ("MCP_CONNECTION_FAILED" as const);
  return new NexusError(code, `MCP "${serverId}" failed to start: ${message}`, {
    details: { serverId },
    cause: error,
  });
}
