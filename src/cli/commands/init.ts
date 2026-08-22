import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMPTY_CONFIG, readConfigFile, writeConfigFile } from "../config-io.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("create a project-mcp.json config in the current project")
    .option("--force", "overwrite an existing project config")
    .action(async (options: { force?: boolean }) => {
      const opts = program.opts<{ cwd?: string }>();
      const cwd = resolve(opts.cwd ?? process.cwd());
      const target = join(cwd, "project-mcp.json");
      if (existsSync(target) && !options.force) {
        console.log(`Config already exists: ${target}`);
        console.log("Use --force to overwrite it.");
        return;
      }
      const base = existsSync(target) ? readConfigFile(target) : EMPTY_CONFIG;
      writeConfigFile(target, base);
      console.log(`Created ${target}`);
      console.log("");
      console.log("Add downstream MCP servers:");
      console.log("  mcp-nexus add github -- npx -y @modelcontextprotocol/server-github");
      console.log("");
      console.log("Then point your AI harness at Nexus:");
      console.log('  { "mcpServers": { "mcp-nexus": {');
      console.log('    "command": "npx",');
      console.log('    "args": ["-y", "@fyrlabs/mcp-nexus", "--config", "./project-mcp.json"]');
      console.log("  } } }");
    });
}
