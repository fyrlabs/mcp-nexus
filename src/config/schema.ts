import { z } from "zod";

export const SERVER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const serverDefinitionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  command: z.string().min(1).max(4096),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().max(4096).optional(),
  tags: z.array(z.string().max(64)).default([]),
  enabled: z.boolean().default(true),
  alwaysOn: z.boolean().default(false),
});

export const routingSchema = z.object({
  strategy: z.enum(["adaptive", "lexical"]).default("adaptive"),
  semanticSearch: z.boolean().default(false),
  prefetch: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(8),
  minScore: z.number().min(0).max(1).default(0.05),
  aliases: z.record(z.string(), z.string()).default({}),
  weights: z
    .object({
      exact: z.number().min(0).max(1).optional(),
      lexical: z.number().min(0).max(1).optional(),
      semantic: z.number().min(0).max(1).optional(),
      userAffinity: z.number().min(0).max(1).optional(),
      recentUsage: z.number().min(0).max(1).optional(),
      globalUsage: z.number().min(0).max(1).optional(),
      successRate: z.number().min(0).max(1).optional(),
      sequence: z.number().min(0).max(1).optional(),
      pin: z.number().min(0).max(1).optional(),
    })
    .default({}),
  pinnedServers: z.array(z.string()).default([]),
  pinnedCapabilities: z.array(z.string()).default([]),
  disabledServers: z.array(z.string()).default([]),
  disabledCapabilities: z.array(z.string()).default([]),
});

export const lifecycleSchema = z.object({
  startupTimeoutMs: z.number().int().min(1000).max(600000).default(20_000),
  callTimeoutMs: z.number().int().min(1000).max(3600000).default(120_000),
  indexTimeoutMs: z.number().int().min(1000).max(600000).default(30_000),
  hotIdleTimeoutMs: z.number().int().min(0).max(86_400_000).default(15 * 60_000),
  warmIdleTimeoutMs: z.number().int().min(0).max(86_400_000).default(5 * 60_000),
  coldIdleTimeoutMs: z.number().int().min(0).max(86_400_000).default(60_000),
});

export const analyticsSchema = z.object({
  enabled: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(3650).default(90),
});

export const nexusConfigSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), serverDefinitionSchema).default({}),
  routing: routingSchema.prefault({}),
  lifecycle: lifecycleSchema.prefault({}),
  analytics: analyticsSchema.prefault({}),
});

export type NexusConfigFile = z.input<typeof nexusConfigSchema>;
export type NexusConfig = z.output<typeof nexusConfigSchema>;
export type ServerDefinitionInput = z.input<typeof serverDefinitionSchema>;
export type ServerDefinition = z.output<typeof serverDefinitionSchema>;
export type RoutingConfig = z.output<typeof routingSchema>;
export type LifecycleConfig = z.output<typeof lifecycleSchema>;
export type AnalyticsConfig = z.output<typeof analyticsSchema>;
