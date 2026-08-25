import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { EMPTY_CONFIG, readConfigFile, withServers, writeConfigFile } from "../config-io.js";
import { findProjectConfig } from "../../config/paths.js";
import { fail } from "../context.js";

const BUILTIN_SOURCES: Record<string, () => string> = {
  claude: () =>
    join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ),
  "claude-code": () => join(homedir(), ".claude.json"),
  cursor: () => join(homedir(), ".cursor", "mcp.json"),
};

export function registerImport(program: Command): void {
  program
    .command("import <source>")
    .description(
      "import servers from an existing config file or a known harness (claude, claude-code, cursor)",
    )
    .option("--from <harness>", `treat <source> as a harness name (${Object.keys(BUILTIN_SOURCES).join(", ")})`)
    .option("--force", "overwrite entries that already exist in project-mcp.json", false)
    .action(async (source: string, options: { from?: string; force?: boolean }) => {
      const global = program.opts<{ cwd?: string; config?: string }>();
      try {
        const sourcePath = await resolveSource(source, options.from);
        const imported = extractMcpServers(readConfigFile(sourcePath));
        if (Object.keys(imported).length === 0) {
          console.log(`No servers found in ${sourcePath} (looked for "mcpServers" and "servers")`);
          return;
        }
        const baseDir = resolve(global.cwd ?? process.cwd());
        const targetPath =
          global.config != null
            ? resolve(baseDir, global.config)
            : (findProjectConfig(baseDir) ?? resolve(baseDir, "project-mcp.json"));
        const target = existsSync(targetPath) ? readConfigFile(targetPath) : EMPTY_CONFIG;

        let added = 0;
        let skipped = 0;
        let skippedRemote = 0;
        const next = withServers(target, (servers) => {
          for (const [id, definition] of Object.entries(imported)) {
            if (!isStdioDefinition(definition)) {
              skippedRemote++;
              continue;
            }
            const existsAlready = isRecord(servers[id]);
            if (existsAlready && !options.force) {
              skipped++;
              continue;
            }
            servers[id] = normalizeDefinition(definition);
            added++;
          }
        });
        writeConfigFile(targetPath, next);
        console.log(`Imported ${added} server(s) from ${sourcePath} into ${targetPath}`);
        if (hasLiteralSecrets(imported)) {
          console.log("Warning: imported entries contain literal values for secret-looking env keys.");
          console.log("Consider replacing them with ${VAR} references in the config.");
        }
        if (skipped > 0) {
          console.log(`Skipped ${skipped} existing entr(y/ies). Use --force to overwrite.`);
        }
        if (skippedRemote > 0) {
          console.log(`Skipped ${skippedRemote} non-stdio entr(y/ies); Nexus routes stdio servers only.`);
        }
        if (hasInputPlaceholders(imported)) {
          console.log("Warning: imported entries contain VS Code ${input:...} placeholders, which Nexus does not resolve.");
          console.log("Replace them with ${VAR} references to your environment.");
        }
      } catch (error) {
        fail(error);
      }
    });
}

async function resolveSource(source: string, from?: string): Promise<string> {
  const harnessKey = from ?? (source in BUILTIN_SOURCES ? source : undefined);
  if (harnessKey) {
    const builder = BUILTIN_SOURCES[harnessKey];
    if (!builder) {
      throw new Error(`Unknown harness "${harnessKey}". Known: ${Object.keys(BUILTIN_SOURCES).join(", ")}`);
    }
    return builder();
  }
  return resolve(process.cwd(), source);
}

function extractMcpServers(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  for (const key of ["mcpServers", "servers"]) {
    const servers = raw[key];
    if (isRecord(servers)) return servers;
  }
  return {};
}

function isStdioDefinition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.type === "string" && value.type !== "stdio") return false;
  return typeof value.command === "string";
}

function normalizeDefinition(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid server definition in import source");
  const output: Record<string, unknown> = {};
  for (const key of ["command", "args", "env", "cwd", "description", "tags", "enabled", "alwaysOn"]) {
    if (value[key] !== undefined) output[key] = value[key];
  }
  if (typeof output.command !== "string") {
    throw new Error("Imported server definitions must include a string command");
  }
  return output;
}

function hasInputPlaceholders(servers: Record<string, unknown>): boolean {
  return /\$\{input:/.test(JSON.stringify(servers));
}

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|credential)/i;

function hasLiteralSecrets(servers: Record<string, unknown>): boolean {
  for (const definition of Object.values(servers)) {
    if (!isRecord(definition) || !isRecord(definition.env)) continue;
    for (const [key, value] of Object.entries(definition.env)) {
      if (typeof value === "string" && SECRET_KEY_PATTERN.test(key) && !/\$\{[A-Za-z_]/.test(value)) {
        return true;
      }
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
