import type { ResolvedConfig } from "../config/loader.js";
import { loadConfig } from "../config/loader.js";
import { Database } from "../storage/database.js";
import { CapabilityRepository } from "../storage/capability-repository.js";
import { ServerRepository } from "../storage/server-repository.js";
import { AnalyticsRepository } from "../storage/analytics-repository.js";
import { Registry } from "../registry/registry.js";
import { StdioTransportFactory } from "../mcp/transport-factory.js";
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

export interface RuntimeOptions {
  configPath?: string;
  cwd?: string;
  logger?: Logger;
  embeddingProvider?: EmbeddingProvider;
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

  const catalog: ServerCatalog = {
    get: (serverId) => registry.definition(serverId),
    ids: () => registry.allDefinitions().map((definition) => definition.id),
  };

  const lifecycle = new LifecycleManager(
    catalog,
    new StdioTransportFactory(),
    packageVersion(),
    timeouts,
    logger.child("lifecycle"),
    {
      onStarted: (serverId) => {
        capabilityIndex.markAvailable(serverId);
        analytics.record({ type: "server.started", serverId });
      },
      onStopped: (serverId) => {
        analytics.record({ type: "server.disconnected", serverId });
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
    options.embeddingProvider ?? new NullEmbeddingProvider(),
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
      lifecycle.startSweeper();
      for (const problem of missingEnvSummary(config)) {
        logger.warn("environment variables referenced but not set", { detail: problem });
      }
    },
    startIndexing: (startOptions = {}) => capabilityIndex.ensureIndexed(startOptions),
    shutdown: async () => {
      lifecycle.stopSweeper();
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
