import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const PROJECT_CONFIG_NAMES = ["project-mcp.json", "nexus.mcp.json"] as const;
export const DATA_DIR_NAME = ".mcp-nexus";

function xdg(envVar: string, fallback: string): string {
  const value = process.env[envVar];
  if (value && value.trim().length > 0) return value.trim();
  return join(homedir(), fallback);
}

export function globalConfigPath(): string {
  return join(xdg("XDG_CONFIG_HOME", ".config"), "mcp-nexus", "config.json");
}

export function findProjectConfig(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir);
  for (let depth = 0; depth < 256; depth++) {
    for (const name of PROJECT_CONFIG_NAMES) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function resolveProjectRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const found = findProjectConfig();
  if (found) return resolve(found, "..");
  return process.cwd();
}

export function dataDirFor(projectRoot: string, hasProjectConfig: boolean): string {
  if (hasProjectConfig) {
    return join(projectRoot, DATA_DIR_NAME);
  }
  return join(xdg("XDG_DATA_HOME", ".local/share"), "mcp-nexus");
}

export function databasePathFor(dataDir: string): string {
  return join(dataDir, "nexus.db");
}

export function logsDirFor(dataDir: string): string {
  return join(dataDir, "logs");
}

export function assertInsideRoot(root: string, candidate: string, label: string): string {
  const resolvedCandidate = resolve(root, candidate);
  const normalizedRoot = resolve(root);
  if (!resolvedCandidate.startsWith(normalizedRoot + "/") && resolvedCandidate !== normalizedRoot) {
    throw Object.assign(new Error(`${label} "${candidate}" resolves outside of "${normalizedRoot}"`), {
      code: "PATH_TRAVERSAL",
    });
  }
  return resolvedCandidate;
}

export function toAbsolutePath(candidate: string, base: string): string {
  return isAbsolute(candidate) ? candidate : resolve(base, candidate);
}
