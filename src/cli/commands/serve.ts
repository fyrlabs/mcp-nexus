import type { Command } from "commander";
import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRuntime } from "../../runtime/create-runtime.js";
import { createNexusMcpServer } from "../../mcp/nexus-server.js";
import { dataDirFor, findProjectConfig } from "../../config/paths.js";
import { createLogger, type Logger } from "../../utils/logger.js";
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

function resolveLogPath(ctx: CommandContext): string | null {
  try {
    const projectConfig = ctx.configPath
      ? resolve(ctx.cwd, ctx.configPath)
      : findProjectConfig(ctx.cwd);
    const projectRoot = projectConfig ? dirname(projectConfig) : ctx.cwd;
    const scope = projectConfig !== null ? "project" : "global";
    return join(dataDirFor(projectRoot, scope), "logs", "runtime.log");
  } catch {
    return null;
  }
}

class TeeStream extends Writable {
  constructor(private readonly targets: NodeJS.WritableStream[]) {
    super();
  }

  override _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    for (const target of this.targets) {
      target.write(chunk);
    }
    callback();
  }
}

function createServeLogger(ctx: CommandContext): { logger: Logger; close(): void; logPath: string | null } {
  const logPath = resolveLogPath(ctx);
  if (logPath === null) {
    return { logger: createLogger("nexus"), close: () => undefined, logPath };
  }
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    const fileStream = createWriteStream(logPath, { flags: "a" });
    const tee = new TeeStream([process.stderr, fileStream]);
    return {
      logger: createLogger("nexus", { stream: tee }),
      close: () => fileStream.end(),
      logPath,
    };
  } catch {
    return { logger: createLogger("nexus"), close: () => undefined, logPath };
  }
}

async function serve(ctx: CommandContext): Promise<void> {
  const { logger, close, logPath } = createServeLogger(ctx);
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
    close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await mcpServer.connect(new StdioServerTransport());
  logger.info("mcp-nexus serving on stdio", {
    servers: Object.keys(runtime.config.servers).length,
    logFile: logPath ?? undefined,
  });
}
