import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMPTY_CONFIG, readConfigFile, withServers, writeConfigFile } from "../config-io.js";
import { findProjectConfig } from "../../config/paths.js";
import { fail } from "../context.js";

export interface AddOptions {
  description?: string;
  tag?: string[];
  env?: string[];
  serverCwd?: string;
  alwaysOn?: boolean;
}

export function registerAdd(program: Command): void {
  program
    .command("add <name>")
    .argument(
      "[parts...]",
      "downstream command and its arguments placed after --, e.g.: mcp-nexus add github -- npx -y @modelcontextprotocol/server-github",
    )
    .option("-d, --description <text>", "human-readable server description")
    .option("-t, --tag <tag>", "tags used for discovery (repeatable)", collectRepeated)
    .option(
      "-e, --env <KEY=VALUE>",
      "environment variable for the downstream process; values may reference ${VAR} or ${VAR:-default} (repeatable)",
      collectRepeated,
    )
    .option("--server-cwd <dir>", "working directory for the downstream process")
    .option("--always-on", "start this server eagerly while nexus is serving", false)
    .action(async (name: string, parts: string[], options: AddOptions) => {
      const global = program.opts<{ cwd?: string; config?: string }>();
      const baseDir = resolve(global.cwd ?? process.cwd());
      const configPath =
        global.config != null
          ? resolve(baseDir, global.config)
          : (findProjectConfig(baseDir) ?? join(baseDir, "project-mcp.json"));

      await run().catch(fail);

      async function run(): Promise<void> {
        if (!existsSync(configPath) && global.config != null) {
          throw new Error(`Config file not found: ${configPath}`);
        }
        if (parts.length === 0) {
          throw new Error(
            "No command given. Usage: mcp-nexus add <name> [flags] -- <command> [args...]\nExample: mcp-nexus add github -- npx -y @modelcontextprotocol/server-github",
          );
        }
        const [command = "", ...args] = parts;
        const env = parseEnvPairs(options.env ?? []);
        const config = existsSync(configPath) ? readConfigFile(configPath) : EMPTY_CONFIG;
        const next = withServers(config, (servers) => {
          servers[name] = {
            ...(isRecord(servers[name]) ? servers[name] : {}),
            name,
            command,
            args,
            ...(options.description ? { description: options.description } : {}),
            ...(env ? { env } : {}),
            ...(options.tag && options.tag.length > 0 ? { tags: options.tag } : {}),
            ...(options.serverCwd ? { cwd: options.serverCwd } : {}),
            ...(options.alwaysOn ? { alwaysOn: true } : {}),
          };
        });
        writeConfigFile(configPath, next);
        console.log(`Added "${name}": ${command} ${args.join(" ")}`.trimEnd());
        console.log(`Config: ${configPath}`);
        if (env && hasLiteralSecrets(env)) {
          console.log("Warning: this config stores secret-looking values in plaintext.");
          console.log("Prefer environment references instead: -e API_TOKEN='${API_TOKEN}'.");
        }
        if (env && hasUnresolvedPlaceholders(env)) {
          console.log("Note: some referenced environment variables are not set in this shell.");
        }
      }
    });
}

function parseEnvPairs(pairs: string[]): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid --env entry "${pair}", expected KEY=VALUE`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

function hasUnresolvedPlaceholders(env: Record<string, string>): boolean {
  return Object.entries(env).some(([key, value]) => key in process.env === false && /\$\{[A-Za-z_]/.test(value));
}

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|credential)/i;

function hasLiteralSecrets(env: Record<string, string>): boolean {
  return Object.entries(env).some(([key, value]) => SECRET_KEY_PATTERN.test(key) && !/\$\{[A-Za-z_]/.test(value));
}

function collectRepeated(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
