import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import type { NexusConfigFile } from "../config/schema.js";
import { NexusError } from "../models/errors.js";
import { globalConfigPath } from "../config/paths.js";

export function readConfigFile(path: string): NexusConfigFile {
  if (!existsSync(path)) {
    throw new NexusError("CONFIG_NOT_FOUND", `Config file not found: ${path}`, { details: { path } });
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as NexusConfigFile;
  } catch (error) {
    throw new NexusError("CONFIG_INVALID", `Config file ${path} is not valid JSON`, {
      details: { path },
      cause: error,
    });
  }
}

export const BACKUP_KEEP = 10;

export function backupDirFor(configPath: string): string {
  const dir = dirname(configPath);
  if (configPath === globalConfigPath()) return join(dir, "backups");
  return join(dir, ".mcp-nexus", "config-backups");
}

export interface ConfigBackup {
  id: string;
  path: string;
}

export function listConfigBackups(configPath: string): ConfigBackup[] {
  const dir = backupDirFor(configPath);
  if (!existsSync(dir)) return [];
  const prefix = `${basename(configPath)}.`;
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => ({ id: name.slice(prefix.length, -".json".length), path: join(dir, name) }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

function backupExisting(configPath: string): void {
  if (!existsSync(configPath)) return;
  const dir = backupDirFor(configPath);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let id = stamp;
  for (let attempt = 2; existsSync(join(dir, `${basename(configPath)}.${id}.json`)); attempt++) {
    id = `${stamp}-${attempt}`;
  }
  copyFileSync(configPath, join(dir, `${basename(configPath)}.${id}.json`));
  for (const stale of listConfigBackups(configPath).slice(BACKUP_KEEP)) {
    rmSync(stale.path, { force: true });
  }
}

export function writeConfigFile(path: string, config: NexusConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  backupExisting(path);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

export const EMPTY_CONFIG: NexusConfigFile = { version: 1, servers: {} };

export function withServers(
  config: NexusConfigFile,
  mutate: (servers: Record<string, Record<string, unknown>>) => void,
): NexusConfigFile {
  const base = { ...config, version: 1 as const };
  const rawServers: Record<string, unknown> = isRecord(base.servers) ? { ...base.servers } : {};
  mutate(rawServers as Record<string, Record<string, unknown>>);
  return { ...base, servers: rawServers } as NexusConfigFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
