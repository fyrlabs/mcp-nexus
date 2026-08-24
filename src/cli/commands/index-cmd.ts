import type { Command } from "commander";
import { printTable, type Table } from "./format.js";
import { watchConfigFile } from "../config-watch.js";
import { createRuntime } from "../../runtime/create-runtime.js";
import { withRuntime, fail } from "../context.js";
import { createLogger } from "../../utils/logger.js";

interface IndexOptions {
  force?: boolean;
  server?: string;
  watch?: boolean;
}

export function registerIndex(program: Command): void {
  program
    .command("index")
    .description("start configured servers as needed and (re)index their capabilities")
    .option("-f, --force", "reindex every server even when the index looks fresh", false)
    .option("-s, --server <id>", "limit indexing to a single server id")
    .option("-w, --watch", "keep running and re-index automatically when the config file changes", false)
    .action(async (options: IndexOptions) => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      const ctx = { cwd: opts.cwd ?? process.cwd(), configPath: opts.config };
      if (options.watch) {
        await watchLoop(ctx, options).catch(fail);
        return;
      }
      try {
        await withRuntime(ctx, async (runtime) => {
          const results = await runtime.startIndexing({
            force: options.force,
            serverIds: options.server ? [options.server] : undefined,
          });
          report(results, runtime.index.count());
        });
      } catch (error) {
        fail(error);
      }
    });
}

function report(results: Array<{ serverId: string; indexed: number; durationMs: number }>, total: number): void {
  if (results.length === 0) {
    console.log("Index already up to date. Use --force to rebuild.");
    return;
  }
  const table: Table = {
    columns: ["SERVER", "CAPABILITIES", "DURATION"],
    rows: results.map((result) => [result.serverId, String(result.indexed), `${result.durationMs}ms`]),
  };
  printTable(table);
  console.log(`Total indexed capabilities: ${total}`);
}

async function watchLoop(
  ctx: { cwd: string; configPath?: string },
  options: IndexOptions,
): Promise<void> {
  const logger = createLogger("nexus");
  const state: { running: boolean; watcher: { dispose(): void } | null; watchedPath: string | null } = {
    running: true,
    watcher: null,
    watchedPath: null,
  };

  process.on("SIGINT", () => {
    state.running = false;
  });

  const indexOnce = async (): Promise<string | null> => {
    const runtime = createRuntime({ cwd: ctx.cwd, configPath: ctx.configPath, logger });
    await runtime.initialize();
    try {
      const results = await runtime.startIndexing({
        force: options.force,
        serverIds: options.server ? [options.server] : undefined,
      });
      report(results, runtime.index.count());
      return runtime.config.paths.projectConfig;
    } finally {
      await runtime.shutdown();
    }
  };

  const onConfigChange = (): void => {
    if (!state.running) return;
    console.log("Config changed, re-indexing...");
    void indexOnce()
      .then((nextPath) => {
        if (state.running && nextPath && nextPath !== state.watchedPath) {
          rearm(nextPath);
        }
      })
      .catch((error) => {
        console.error(`re-index failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const rearm = (path: string): void => {
    state.watcher?.dispose();
    state.watchedPath = path;
    state.watcher = watchConfigFile(path, onConfigChange);
  };

  try {
    const configPath = await indexOnce();
    if (!configPath) {
      console.log("No project config to watch (defaults only). Use --config to point at a file.");
      return;
    }
    rearm(configPath);
    console.log(`Watching ${configPath} for changes. Ctrl+C to stop.`);
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!state.running) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });
  } finally {
    state.watcher?.dispose();
    console.log("Stopped watching.");
  }
}
