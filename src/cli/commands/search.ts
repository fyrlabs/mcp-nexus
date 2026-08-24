import type { Command } from "commander";
import { printTable, type Table } from "./format.js";
import { withRuntime, fail } from "../context.js";

export function registerSearch(program: Command): void {
  program
    .command("search <query...>")
    .description("search capabilities through the same adaptive router the agent control plane uses")
    .option("-l, --limit <n>", "maximum results", parsePositiveInt)
    .option("-s, --server <id>", "restrict to one server id")
    .option("--explain", "show per-signal scores", false)
    .action(async (queryParts: string[], options: { limit?: number; server?: string; explain?: boolean }) => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      const query = queryParts.join(" ");
      try {
        await withRuntime({ cwd: opts.cwd ?? process.cwd(), configPath: opts.config }, async (runtime) => {
          const matches = await runtime.router.search(query, {
            limit: options.limit ?? runtime.config.routing.limit,
            serverIds: options.server ? [options.server] : undefined,
          });
          if (matches.length === 0) {
            console.log("No matching capabilities. Try broader keywords or `mcp-nexus index --force`.");
            return;
          }
          const table: Table = {
            columns: ["SCORE", "CAPABILITY", "SERVER", "TOOL"],
            rows: matches.map((match) => [
              match.score.toFixed(3),
              match.capabilityId,
              match.serverId,
              match.toolName,
            ]),
          };
          printTable(table);
          if (options.explain) {
            console.log("");
            for (const match of matches) {
              const signals = Object.entries(match.signals)
                .filter(([, value]) => value > 0)
                .map(([key, value]) => `${key}=${value}`)
                .join(" ");
              console.log(`  ${match.capabilityId}`);
              console.log(`    ${signals || "(no signals)"}`);
              console.log(`    reason: ${match.reason}`);
            }
          }
        });
      } catch (error) {
        fail(error);
      }
    });
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid limit "${value}"`);
  }
  return parsed;
}
