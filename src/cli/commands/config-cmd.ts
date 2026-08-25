import type { Command } from "commander";
import { resolve } from "node:path";
import { printTable, type Table } from "./format.js";
import { loadConfig } from "../../config/loader.js";
import { listConfigBackups, readConfigFile, writeConfigFile } from "../config-io.js";
import { fail } from "../context.js";

export function registerConfig(program: Command): void {
  const config = program.command("config").description("inspect configuration resolution");

  config
    .command("path")
    .description("show which config files apply and where data is stored")
    .action(async () => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      try {
        const resolved = loadConfig({ cwd: opts.cwd ?? process.cwd(), configPath: opts.config });
        console.log(`Global config:  ${resolved.paths.globalConfig}`);
        console.log(`Project config: ${resolved.paths.projectConfig ?? "(not found)"}`);
        console.log(`Project root:   ${resolved.paths.projectRoot}`);
        console.log(`Data dir:       ${resolved.paths.dataDir}`);
        console.log(`Database:       ${resolved.paths.database}`);
        const servers = Object.entries(resolved.servers);
        if (servers.length > 0) {
          console.log("");
          const table: Table = {
            columns: ["SERVER", "SOURCE", "ENABLED", "COMMAND"],
            rows: servers.map(([id, definition]) => [
              id,
              definition.source,
              definition.enabled ? "yes" : "no",
              definition.displayCommand,
            ]),
          };
          printTable(table);
        }
      } catch (error) {
        process.exitCode = 1;
        console.error(error instanceof Error ? error.message : String(error));
      }
    });

  config
    .command("template")
    .description("print a fully commented example nexus config")
    .action(() => {
      console.log(TEMPLATE.trimStart());
    });

  config
    .command("backups")
    .description("list saved config snapshots, newest first")
    .action(() => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      try {
        const target = targetConfigPath(opts);
        const backups = listConfigBackups(target);
        if (backups.length === 0) {
          console.log(`No backups for ${target}`);
          return;
        }
        console.log(`Backups for ${target}:`);
        printTable({
          columns: ["ID", "PATH"],
          rows: backups.map((backup) => [backup.id, backup.path]),
        });
      } catch (error) {
        fail(error);
      }
    });

  config
    .command("restore [id]")
    .description("restore the config from a backup (defaults to the newest)")
    .action((id: string | undefined) => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      try {
        const target = targetConfigPath(opts);
        const backups = listConfigBackups(target);
        const chosen = id ? backups.find((backup) => backup.id === id) : backups[0];
        if (!chosen) {
          throw new Error(
            id
              ? `No backup "${id}" for ${target}. Run "mcp-nexus config backups" to list them.`
              : `No backups for ${target}.`,
          );
        }
        writeConfigFile(target, readConfigFile(chosen.path));
        console.log(`Restored ${target} from backup ${chosen.id}`);
        console.log("The config as it was before this restore was itself saved as a new backup.");
      } catch (error) {
        fail(error);
      }
    });
}

function targetConfigPath(opts: { cwd?: string; config?: string }): string {
  const baseDir = resolve(opts.cwd ?? process.cwd());
  if (opts.config != null) return resolve(baseDir, opts.config);
  const resolved = loadConfig({ cwd: baseDir });
  return resolved.paths.projectConfig ?? resolved.paths.globalConfig;
}

const TEMPLATE = `
{
  "version": 1,
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" },
      "tags": ["github", "code-review", "development"]
    }
  },
  "routing": {
    "semanticSearch": false,
    "aliases": {},
    "pinnedCapabilities": [],
    "disabledCapabilities": [],
    "disabledServers": []
  },
  "lifecycle": {
    "startupTimeoutMs": 20000,
    "callTimeoutMs": 120000,
    "hotIdleTimeoutMs": 900000,
    "warmIdleTimeoutMs": 300000,
    "coldIdleTimeoutMs": 60000,
    "quarantineThreshold": 3,
    "quarantineBackoffMs": 30000,
    "quarantineMaxBackoffMs": 300000
  },
  "analytics": {
    "enabled": true,
    "retentionDays": 90
  }
}
`;
