export const RISK_LEVELS = ["read", "write", "destructive", "unknown"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const SERVER_STATUSES = [
  "registered",
  "not_started",
  "starting",
  "running",
  "idle",
  "stopped",
  "failed",
] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

export const AVAILABILITY = ["available", "stale", "unavailable", "unknown"] as const;
export type Availability = (typeof AVAILABILITY)[number];

export interface MCPServerDefinition {
  id: string;
  name?: string;
  description?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  tags: string[];
  enabled: boolean;
  alwaysOn: boolean;
  source: ConfigSource;
}

export type ConfigSource = "global" | "project" | "cli";

export interface CapabilityMetadata {
  tags: string[];
  keywords: string[];
  risk: RiskLevel;
}

export interface Capability {
  capabilityId: string;
  serverId: string;
  toolName: string;
  title: string;
  description: string;
  inputSchemaSummary: Record<string, unknown>;
  metadata: CapabilityMetadata;
  availability: Availability;
  updatedAt: number;
}

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  serverIds?: string[];
}

export interface RoutingContext {
  sessionId?: string;
  projectScope?: string;
  taskHint?: string;
  limit?: number;
  serverIds?: string[];
  now?: number;
}

export interface ScoreSignals {
  exact: number;
  lexical: number;
  semantic: number;
  userAffinity: number;
  recentUsage: number;
  globalUsage: number;
  successRate: number;
  sequence: number;
  pin: number;
}

export interface CapabilityMatch {
  capabilityId: string;
  serverId: string;
  toolName: string;
  title: string;
  description: string;
  score: number;
  signals: ScoreSignals;
  reason: string;
  risk: RiskLevel;
  flags: string[];
}

export interface ExecutionContext extends RoutingContext {
  requestedBy?: string;
}

export const ANALYTICS_EVENT_TYPES = [
  "server.discovered",
  "server.started",
  "server.connected",
  "server.disconnected",
  "capability.indexed",
  "capability.searched",
  "capability.selected",
  "capability.described",
  "capability.executed",
  "execution.succeeded",
  "execution.failed",
  "search.converted",
  "search.no_result",
  "prediction.used",
  "prediction.unused",
] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  sessionId?: string;
  serverId?: string;
  capabilityId?: string;
  query?: string;
  latencyMs?: number;
  success?: boolean;
  source?: string;
  timestamp?: number;
}

export interface ToolStats {
  capabilityId: string;
  serverId: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  avgLatencyMs: number;
  lastUsedAt: number | null;
  successRate: number;
}

export interface SequenceStats {
  previousCapabilityId: string;
  nextCapabilityId: string;
  occurrences: number;
  probability: number;
}

export interface ServerSummary {
  id: string;
  name: string;
  description: string;
  status: ServerStatus;
  enabled: boolean;
  alwaysOn: boolean;
  tags: string[];
  transport: "stdio";
  capabilitiesIndexed: number;
  source: ConfigSource;
}

export interface NexusStatus {
  configPath: string | null;
  databasePath: string;
  serversTotal: number;
  serversRunning: number;
  capabilitiesIndexed: number;
  hot: number;
  warm: number;
  cold: number;
  analyticsEnabled: boolean;
}
