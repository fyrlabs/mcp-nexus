import type { ResolvedConfig } from "../config/loader.js";
import { loadConfig } from "../config/loader.js";
import { Database } from "../storage/database.js";
import { CapabilityRepository } from "../storage/capability-repository.js";
import { ServerRepository } from "../storage/server-repository.js";
import { AnalyticsRepository } from "../storage/analytics-repository.js";
import { Registry } from "../registry/registry.js";
import { StdioTransportFactory, type TransportFactory } from "../mcp/transport-factory.js";
import { LifecycleManager, type LifecycleTimeouts } from "../lifecycle/lifecycle-manager.js";
import { CapabilityIndex } from "../index/capability-index.js";
import { AnalyticsEngine } from "../analytics/analytics-engine.js";
import { PolicyEngine } from "../router/policies.js";
import { Ranker } from "../router/ranker.js";
import { Predictor } from "../router/predictor.js";
import { Router } from "../router/router.js";
import type { ServerCatalog } from "../lifecycle/lifecycle-manager.js";
import type { Logger } from "../utils/logger.js";
import { createLogger } from "../utils/logger.js";
import { packageVersion } from "../utils/version.js";
import type { NexusRuntime } from "./types.js";
import { NullEmbeddingProvider, type EmbeddingProvider } from "../index/semantic.js";
import { RETENTION_SWEEP_INTERVAL_MS } from "../analytics/analytics-engine.js";
import { createEmbeddingProvider } from "../index/embedding-providers.js";
import { EmbeddingCacheRepository } from "../storage/embedding-cache-repository.js";

export interface RuntimeOptions {
  configPath?: string;
  cwd?: string;
  logger?: Logger;
  embeddingProvider?: EmbeddingProvider;
  transportFactory?: TransportFactory;
}

export function createRuntime(options: RuntimeOptions = {}): NexusRuntime {
  const logger = options.logger ?? createLogger("nexus");
  const config: ResolvedConfig = loadConfig({
    configPath: options.configPath,
    cwd: options.cwd,
    logger,
  });

  const database = new Database(config.paths.database);
  database.migrate();

  const serverRepo = new ServerRepository(database);
  const capabilityRepo = new CapabilityRepository(database);
  const analyticsRepo = new AnalyticsRepository(database);
  const registry = new Registry(config, serverRepo, capabilityRepo);

  const timeouts: LifecycleTimeouts = {
    startupTimeoutMs: config.lifecycle.startupTimeoutMs,
    callTimeoutMs: config.lifecycle.callTimeoutMs,
    indexTimeoutMs: config.lifecycle.indexTimeoutMs,
    hotIdleTimeoutMs: config.lifecycle.hotIdleTimeoutMs,
    warmIdleTimeoutMs: config.lifecycle.warmIdleTimeoutMs,
    coldIdleTimeoutMs: config.lifecycle.coldIdleTimeoutMs,
  };

  const analytics = new AnalyticsEngine(
    analyticsRepo,
    capabilityRepo,
    { enabled: config.analytics.enabled, retentionDays: config.analytics.retentionDays },
  );

  let retentionTimer: NodeJS.Timeout | null = null;

  const embeddingProvider =
    options.embeddingProvider ??
    (config.routing.semanticSearch
      ? createEmbeddingProvider(config.routing.semantic)
      : new NullEmbeddingProvider());
  const embeddingCache = new EmbeddingCacheRepository(database);
  const semanticCacheAdapter = {
    loadAll: () => embeddingCache.loadAll(embeddingProvider.name, embeddingProvider.model ?? ""),
    store: (entries: Map<string, { vector: Float32Array; contentHash: string }>) =>
      embeddingCache.store(
        new Map(
          [...entries].map(([id, entry]) => [
            id,
            {
              provider: embeddingProvider.name,
              model: embeddingProvider.model ?? "",
              contentHash: entry.contentHash,
              vector: entry.vector,
            },
          ]),
        ),
      ),
  };

  const catalog: ServerCatalog = {
    get: (serverId) => registry.definition(serverId),
    ids: () => registry.allDefinitions().map((definition) => definition.id),
  };

  const lifecycle = new LifecycleManager(
    catalog,
    options.transportFactory ?? new StdioTransportFactory(),
    packageVersion(),
    timeouts,
    logger.child("lifecycle"),
    {
      onStarted: (serverId) => {
        capabilityIndex.markAvailable(serverId);
        serverRepo.setStatus(serverId, "running");
        analytics.record({ type: "server.started", serverId });
      },
      onStopped: (serverId) => {
        serverRepo.setStatus(serverId, "stopped");
        analytics.record({ type: "server.disconnected", serverId });
      },
      onStartFailed: (serverId) => {
        serverRepo.setStatus(serverId, "failed");
      },
    },
    (serverId) => sumUsageForServer(analytics, capabilityRepo, serverId),
  );

  const capabilityIndex = new CapabilityIndex(
    lifecycle,
    capabilityRepo,
    serverRepo,
    registry,
    config.routing,
    logger.child("index"),
    { onEvent: (event) => analytics.record(event) },
    embeddingProvider,
    Date.now,
    semanticCacheAdapter,
  );

  const policies = new PolicyEngine(config.routing);
  const ranker = new Ranker(config.routing.weights);
  const predictor = new Predictor(analytics);
  const router = new Router(
    capabilityIndex,
    lifecycle,
    policies,
    ranker,
    predictor,
    analytics,
    config.routing,
    logger.child("router"),
  );

  return {
    config,
    registry,
    lifecycle,
    index: capabilityIndex,
    analytics,
    policies,
    ranker,
    predictor,
    router,
    initialize: async () => {
      registry.syncAll();
      await capabilityIndex.hydrate();
      const pruned = analytics.prune();
      if (pruned > 0) logger.info("pruned expired analytics events", { pruned });
      retentionTimer = setInterval(() => {
        try {
          analytics.prune();
        } catch (error) {
          logger.warn("retention sweep failed", { error: String(error) });
        }
      }, RETENTION_SWEEP_INTERVAL_MS);
      retentionTimer.unref?.();
      lifecycle.startSweeper();
      for (const problem of missingEnvSummary(config)) {
        logger.warn("environment variables referenced but not set", { detail: problem });
      }
    },
    startIndexing: (startOptions = {}) => capabilityIndex.ensureIndexed(startOptions),
    execute: (capabilityId, args, context) => router.execute(capabilityId, args ?? {}, context ?? {}),
    shutdown: async () => {
      lifecycle.stopSweeper();
      if (retentionTimer) clearInterval(retentionTimer);
      await lifecycle.dispose();
      database.close();
      logger.info("runtime shut down");
    },
  };
}

function sumUsageForServer(
  analytics: AnalyticsEngine,
  capabilities: CapabilityRepository,
  serverId: string,
): number {
  let total = 0;
  const stats = analytics.getRoutingStats();
  for (const capability of capabilities.listByServer(serverId)) {
    total += stats.get(capability.capabilityId)?.usageCount ?? 0;
  }
  return total;
}

function missingEnvSummary(config: ResolvedConfig): string[] {
  const problems: string[] = [];
  for (const [id, server] of Object.entries(config.servers)) {
    if (!server.enabled || server.missingEnvVars.length === 0) continue;
    problems.push(`${id}: ${server.missingEnvVars.join(", ")}`);
  }
  return problems;
}
