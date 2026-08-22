import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRuntime } from "../../runtime/create-runtime.js";
import { createNexusMcpServer } from "../../mcp/nexus-server.js";
import { createLogger } from "../../utils/logger.js";
import type { CommandContext } from "../context.js";
import { fail } from "../context.js";

export function registerServe(program: Command): void {
  program
    .command("serve")
    .description("run the MCP Nexus server over stdio (this is what your AI harness connects to)")
    .action(async () => {
      const opts = program.opts<{ config?: string; cwd?: string }>();
      const ctx: CommandContext = { cwd: opts.cwd ?? process.cwd(), configPath: opts.config };
      await serve(ctx).catch(fail);
    });
}

async function serve(ctx: CommandContext): Promise<void> {
  const logger = createLogger("nexus");
  const runtime = createRuntime({ cwd: ctx.cwd, configPath: ctx.configPath, logger });
  await runtime.initialize();

  void runtime
    .startIndexing()
    .then((results) => {
      logger.info("background indexing complete", {
        servers: results.map((result) => result.serverId),
        capabilities: results.reduce((sum, result) => sum + result.indexed, 0),
      });
    })
    .catch((error) => {
      logger.warn("background indexing failed", { error: String(error) });
    });

  void runtime.lifecycle.startAlwaysOnServers();

  const mcpServer = createNexusMcpServer({
    router: runtime.router,
    registry: runtime.registry,
    index: runtime.index,
    analytics: runtime.analytics,
  });

  const shutdown = async (): Promise<void> => {
    await runtime.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await mcpServer.connect(new StdioServerTransport());
  logger.info("mcp-nexus serving on stdio", {
    servers: Object.keys(runtime.config.servers).length,
  });
}
