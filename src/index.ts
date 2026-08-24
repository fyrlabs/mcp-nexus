export { NexusError, NEXUS_ERROR_CODES, isNexusError, toNexusError } from "./models/errors.js";
export type { NexusErrorCode } from "./models/errors.js";
export { ANALYTICS_EVENT_TYPES, AVAILABILITY, RISK_LEVELS, SERVER_STATUSES } from "./models/types.js";
export type {
  AnalyticsEvent,
  AnalyticsEventType,
  Availability,
  Capability,
  CapabilityMatch,
  ConfigSource,
  ExecutionContext,
  MCPServerDefinition,
  RiskLevel,
  RoutingContext,
  ScoreSignals,
  SearchOptions,
  ServerStatus,
  ServerSummary,
  SequenceStats,
  ToolStats,
} from "./models/types.js";

export type {
  AnalyticsConfig,
  LifecycleConfig,
  NexusConfigFile,
  RoutingConfig,
  ServerDefinition,
} from "./config/schema.js";
export { nexusConfigSchema } from "./config/schema.js";
export { loadConfig, validateConfig } from "./config/loader.js";
export type { LoadConfigOptions, ResolvedConfig, ResolvedServer } from "./config/loader.js";
export { dataDirFor, databasePathFor, findProjectConfig, globalConfigPath } from "./config/paths.js";
export { substituteEnvDeep } from "./config/env.js";
export { BUILT_IN_ALIASES, expandAliases, normalizeQuery, tokenize } from "./index/text.js";
export { deriveCapabilityId } from "./index/capability-id.js";
export { classifyRisk } from "./index/risk.js";
export { BM25Index } from "./index/bm25.js";
export type { LexicalDocument } from "./index/bm25.js";
export { NullEmbeddingProvider, SemanticIndex, cosineSimilarity } from "./index/semantic.js";
export type { EmbeddingProvider } from "./index/semantic.js";
export {
  HashingEmbeddingProvider,
  OpenAICompatibleProvider,
  createEmbeddingProvider,
} from "./index/embedding-providers.js";
export type { OpenAICompatibleOptions } from "./index/embedding-providers.js";
export type { SemanticCacheAdapter } from "./index/capability-index.js";
export { CapabilityIndex } from "./index/capability-index.js";
export type { IndexResult } from "./index/capability-index.js";
export {
  LifecycleManager,
  DEFAULT_TIMEOUTS,
  DEFAULT_QUARANTINE,
  HOT_USAGE_THRESHOLD,
  WARM_USAGE_THRESHOLD,
} from "./lifecycle/lifecycle-manager.js";
export type {
  LifecycleTimeouts,
  QuarantinePolicy,
  ServerCatalog,
  ServerHealth,
} from "./lifecycle/lifecycle-manager.js";
export { StdioTransportFactory } from "./mcp/transport-factory.js";
export type { TransportFactory } from "./mcp/transport-factory.js";
export { DownstreamClient } from "./mcp/downstream-client.js";
export { createNexusMcpServer, TOOL_NAMES } from "./mcp/nexus-server.js";
export { Registry } from "./registry/registry.js";
export { PolicyEngine } from "./router/policies.js";
export { Ranker, DEFAULT_WEIGHTS } from "./router/ranker.js";
export type { RankingWeights, UsageSignals } from "./router/ranker.js";
export { Predictor } from "./router/predictor.js";
export { Router } from "./router/router.js";
export { createRuntime } from "./runtime/create-runtime.js";
export type { RuntimeOptions } from "./runtime/create-runtime.js";
export type { NexusRuntime } from "./runtime/types.js";
export { Database } from "./storage/database.js";
export { CapabilityRepository } from "./storage/capability-repository.js";
export { ServerRepository } from "./storage/server-repository.js";
export { AnalyticsRepository } from "./storage/analytics-repository.js";
export { EmbeddingCacheRepository } from "./storage/embedding-cache-repository.js";
export { AnalyticsEngine } from "./analytics/analytics-engine.js";
export { createLogger } from "./utils/logger.js";
export type { Logger, LogLevel } from "./utils/logger.js";
export { packageVersion } from "./utils/version.js";
