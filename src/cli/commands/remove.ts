import type { Command } from "commander";
import { readConfigFile, writeConfigFile, withServers } from "../config-io.js";
import { findProjectConfig, globalConfigPath } from "../../config/paths.js";
import { fail } from "../context.js";

export function registerRemove(program: Command): void {
  program
    .command("remove <name>")
    .description("remove a downstream MCP server from the project config")
    .action(async (name: string) => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      try {
        const baseDir = opts.cwd ?? process.cwd();
        const configPath =
          opts.config != null
            ? opts.config
            : (findProjectConfig(baseDir) ??
              (() => {
                throw new Error(
                  `No project config found (looked for project-mcp.json upward from ${baseDir}). Run \`mcp-nexus init\` first.`,
                );
              })());
        const config = readConfigFile(configPath);
        if (!isRecord(config.servers) || !(name in config.servers)) {
          console.log(`"${name}" is not defined in ${configPath}`);
          console.log(`Global config (if any): ${globalConfigPath()}`);
          return;
        }
        const next = withServers(config, (servers) => {
          delete servers[name];
        });
        writeConfigFile(configPath, next);
        console.log(`Removed "${name}" from ${configPath}`);
      } catch (error) {
        fail(error);
      }
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
