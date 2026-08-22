import type { ResolvedConfig } from "../config/loader.js";
import type { AnalyticsEngine } from "../analytics/analytics-engine.js";
import type { CapabilityIndex, IndexResult } from "../index/capability-index.js";
import type { LifecycleManager } from "../lifecycle/lifecycle-manager.js";
import type { Registry } from "../registry/registry.js";
import type { PolicyEngine } from "../router/policies.js";
import type { Ranker } from "../router/ranker.js";
import type { Predictor } from "../router/predictor.js";
import type { Router } from "../router/router.js";
import type { ExecutionContext } from "../models/types.js";

export interface NexusRuntime {
  readonly config: ResolvedConfig;
  readonly registry: Registry;
  readonly lifecycle: LifecycleManager;
  readonly index: CapabilityIndex;
  readonly analytics: AnalyticsEngine;
  readonly policies: PolicyEngine;
  readonly ranker: Ranker;
  readonly predictor: Predictor;
  readonly router: Router;
  initialize(): Promise<void>;
  startIndexing(options?: { force?: boolean; serverIds?: string[] }): Promise<IndexResult[]>;
  execute(
    capabilityId: string,
    args?: Record<string, unknown>,
    context?: ExecutionContext,
  ): Promise<unknown>;
  shutdown(): Promise<void>;
}
