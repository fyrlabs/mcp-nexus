import type { Command } from "commander";
import { printTable, type Table } from "./format.js";
import { loadConfig } from "../../config/loader.js";

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
              [definition.command, ...definition.args].join(" "),
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
    "strategy": "adaptive",
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
    "coldIdleTimeoutMs": 60000
  },
  "analytics": {
    "enabled": true,
    "retentionDays": 90
  }
}
`;
