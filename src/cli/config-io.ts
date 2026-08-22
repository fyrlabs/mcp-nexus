import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NexusConfigFile } from "../config/schema.js";
import { NexusError } from "../models/errors.js";

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

export function writeConfigFile(path: string, config: NexusConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
