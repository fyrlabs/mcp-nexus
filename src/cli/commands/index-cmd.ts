import type { Command } from "commander";
import { printTable, type Table } from "./format.js";
import { withRuntime, fail } from "../context.js";

export function registerIndex(program: Command): void {
  program
    .command("index")
    .description("start configured servers as needed and (re)index their capabilities")
    .option("-f, --force", "reindex every server even when the index looks fresh", false)
    .option("-s, --server <id>", "limit indexing to a single server id")
    .action(async (options: { force?: boolean; server?: string }) => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      try {
        await withRuntime({ cwd: opts.cwd ?? process.cwd(), configPath: opts.config }, async (runtime) => {
          const results = await runtime.startIndexing({
            force: options.force,
            serverIds: options.server ? [options.server] : undefined,
          });
          if (results.length === 0) {
            console.log("Index already up to date. Use --force to rebuild.");
            return;
          }
          const table: Table = {
            columns: ["SERVER", "CAPABILITIES", "DURATION"],
            rows: results.map((result) => [
              result.serverId,
              String(result.indexed),
              `${result.durationMs}ms`,
            ]),
          };
          printTable(table);
          console.log(`Total indexed capabilities: ${runtime.index.count()}`);
        });
      } catch (error) {
        fail(error);
      }
    });
}
