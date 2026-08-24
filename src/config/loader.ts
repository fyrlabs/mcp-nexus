import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { NexusError } from "../models/errors.js";
import type { Logger } from "../utils/logger.js";
import { substituteEnvDeep } from "./env.js";
import { dataDirFor, databasePathFor, findProjectConfig, globalConfigPath, toAbsolutePath } from "./paths.js";
import { nexusConfigSchema, serverDefinitionSchema } from "./schema.js";
import type {
  AnalyticsConfig,
  LifecycleConfig,
  NexusConfigFile,
  RoutingConfig,
  ServerDefinition,
} from "./schema.js";

export interface ResolvedServer extends ServerDefinition {
  id: string;
  source: "global" | "project" | "cli";
  missingEnvVars: string[];
  displayCommand: string;
}

export interface ResolvedConfig {
  version: 1;
  servers: Record<string, ResolvedServer>;
  routing: RoutingConfig;
  lifecycle: LifecycleConfig;
  analytics: AnalyticsConfig;
  paths: {
    globalConfig: string;
    projectConfig: string | null;
    projectRoot: string;
    dataDir: string;
    database: string;
  };
}

export interface LoadConfigOptions {
  configPath?: string;
  cwd?: string;
  overrides?: Partial<NexusConfigFile>;
  logger?: Logger;
}

type ServerEntry = { def: Record<string, unknown>; source: ResolvedServer["source"] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayCommandOf(rawDefinition: unknown): string {
  if (!isRecord(rawDefinition)) return "";
  const command = typeof rawDefinition.command === "string" ? rawDefinition.command : "";
  const args = Array.isArray(rawDefinition.args)
    ? rawDefinition.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return [command, ...args].join(" ").trim();
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(override)) return base;
  if (!isRecord(base)) return structuredClone(override) as T;
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = output[key];
    output[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : structuredClone(value);
  }
  return output as T;
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new NexusError("CONFIG_NOT_FOUND", `Config file not found: ${path}`, { details: { path } });
    }
    throw new NexusError("CONFIG_INVALID", `Cannot read config file ${path}: ${String(error)}`, {
      details: { path },
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new NexusError("CONFIG_INVALID", `Config file ${path} is not valid JSON`, {
      details: { path },
      cause: error,
    });
  }
}

export function parseConfigFile(raw: unknown): NexusConfigFile {
  if (!isRecord(raw)) {
    throw new NexusError("CONFIG_INVALID", "Config root must be a JSON object");
  }
  const version = raw.version;
  if (version !== undefined && version !== 1) {
    throw new NexusError("CONFIG_INVALID", `Unsupported config version: ${JSON.stringify(version)}. Expected 1.`, {
      details: { version },
    });
  }
  return raw as NexusConfigFile;
}

export interface ValidatedConfig {
  version: 1;
  servers: Record<string, ServerDefinition>;
  routing: RoutingConfig;
  lifecycle: LifecycleConfig;
  analytics: AnalyticsConfig;
}

export function validateConfig(raw: unknown): ValidatedConfig {
  const result = nexusConfigSchema.safeParse(parseConfigFile(raw));
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new NexusError("CONFIG_INVALID", `Invalid configuration: ${issues}`, {
      details: { issueCount: result.error.issues.length },
    });
  }
  return result.data;
}

function mergeServerEntries(
  target: Record<string, ServerEntry>,
  raw: unknown,
  source: ServerEntry["source"],
): void {
  if (!isRecord(raw)) return;
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const existing = target[id];
    target[id] = {
      def: isRecord(existing?.def) ? deepMerge(existing.def, value) : structuredClone(value),
      source,
    };
  }
}

function resolveServers(
  mergedServers: Record<string, ServerEntry>,
  cliOverrides: Partial<NexusConfigFile> | undefined,
  baseDir: string,
): Record<string, ResolvedServer> {
  const servers: Record<string, ResolvedServer> = {};
  const overrideServers = cliOverrides?.servers;

  for (const [id, entry] of Object.entries(mergedServers)) {
    const overrideDef = isRecord(overrideServers?.[id]) ? (overrideServers?.[id] as Record<string, unknown>) : undefined;
    const effective = overrideDef ? deepMerge(entry.def, overrideDef) : entry.def;
    const substituted = substituteEnvDeep(effective, (name) => process.env[name]);
    const parsed = validateServer(id, substituted.value);
    servers[id] = {
      ...parsed,
      id,
      name: parsed.name ?? id,
      description: parsed.description ?? "",
      cwd: parsed.cwd ? toAbsolutePath(parsed.cwd, baseDir) : undefined,
      source: overrideDef ? "cli" : entry.source,
      missingEnvVars: substituted.missing,
      displayCommand: displayCommandOf(effective),
    };
  }

  for (const [id, value] of Object.entries(overrideServers ?? {})) {
    if (!isRecord(value) || servers[id]) continue;
    const substituted = substituteEnvDeep(structuredClone(value), (name) => process.env[name]);
    const parsed = validateServer(id, substituted.value);
    servers[id] = {
      ...parsed,
      id,
      name: parsed.name ?? id,
      description: parsed.description ?? "",
      cwd: parsed.cwd ? toAbsolutePath(parsed.cwd, baseDir) : undefined,
      source: "cli",
      missingEnvVars: substituted.missing,
      displayCommand: displayCommandOf(value),
    };
  }

  return servers;
}

function validateServer(id: string, def: Record<string, unknown>): ServerDefinition {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new NexusError("CONFIG_INVALID", `Invalid server id "${id}"`);
  }
  const result = serverDefinitionSchema.safeParse(def);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    throw new NexusError("CONFIG_INVALID", `Invalid definition for server "${id}": ${issues}`);
  }
  return result.data;
}

export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const logger = options.logger;
  const cwd = options.cwd ?? process.cwd();

  const explicitPath = options.configPath ? resolvePath(cwd, options.configPath) : null;
  const discoveredPath = explicitPath ? null : findProjectConfig(cwd);
  const projectPath = explicitPath ?? discoveredPath;
  const baseDir = projectPath ? resolvePath(projectPath, "..") : cwd;

  const globalPath = globalConfigPath();
  let globalRaw: Partial<NexusConfigFile> = {};
  try {
    globalRaw = validateConfig(readJsonFile(globalPath));
  } catch (error) {
    if ((error as NexusError).code === "CONFIG_NOT_FOUND") {
      globalRaw = {};
    } else {
      logger?.warn("Ignoring invalid global config", { path: globalPath, error: String(error) });
    }
  }

  let projectRaw: Partial<NexusConfigFile> = {};
  if (projectPath) {
    projectRaw = validateConfig(readJsonFile(projectPath));
  }

  const mergedServers: Record<string, ServerEntry> = {};
  mergeServerEntries(mergedServers, (globalRaw as { servers?: unknown }).servers, "global");
  mergeServerEntries(mergedServers, (projectRaw as { servers?: unknown }).servers, "project");

  const topLevel = deepMerge(deepMerge(structuredClone(globalRaw), projectRaw), options.overrides ?? {});
  delete topLevel.servers;
  const validated = validateConfig({
    ...topLevel,
    version: 1 as const,
    servers: Object.fromEntries(Object.entries(mergedServers).map(([id, e]) => [id, e.def])),
  });

  const servers = resolveServers(mergedServers, options.overrides, baseDir);
  const disabled = new Set(validated.routing.disabledServers);
  for (const server of Object.values(servers)) {
    server.enabled = server.enabled && !disabled.has(server.id);
  }

  const hasProject = projectPath !== null;
  const projectRoot = hasProject ? resolvePath(projectPath, "..") : cwd;
  const dataDir = dataDirFor(projectRoot, hasProject ? "project" : "global");

  return {
    version: 1,
    servers,
    routing: validated.routing,
    lifecycle: validated.lifecycle,
    analytics: validated.analytics,
    paths: {
      globalConfig: globalPath,
      projectConfig: projectPath,
      projectRoot,
      dataDir,
      database: databasePathFor(dataDir),
    },
  };
}
