import type {
  AnalyticsEvent,
  Capability,
  CapabilityMatch,
  MCPServerDefinition,
  RoutingContext,
  SearchOptions,
  SequenceStats,
  ServerStatus,
  ToolStats,
} from "./types.js";

export type SearchQueryOptions = SearchOptions;

export interface CapabilityIndex {
  indexServer(serverId: string): Promise<number>;
  search(query: string, options?: SearchQueryOptions): Promise<CapabilityMatch[]>;
  get(capabilityId: string): Promise<Capability | undefined>;
  describe(capabilityIds: string[]): Promise<Capability[]>;
  rebuild(): Promise<void>;
}

export interface MCPLifecycleManagerContract {
  ensureStarted(serverId: string): Promise<unknown>;
  stop(serverId: string): Promise<void>;
  status(serverId: string): ServerStatus;
}

export interface AnalyticsStoreContract {
  record(event: AnalyticsEvent): Promise<void>;
  getToolStats(options?: { limit?: number }): Promise<ToolStats[]>;
  getSequenceStats(): Promise<SequenceStats[]>;
  reset(): Promise<void>;
}

export interface RouterDeps {
  index: CapabilityIndex;
  context?: RoutingContext;
}

export interface RegistryLike {
  list(): Promise<MCPServerDefinition[]>;
  get(serverId: string): Promise<MCPServerDefinition | undefined>;
}
