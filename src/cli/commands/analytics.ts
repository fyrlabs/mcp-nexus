import type { Command } from "commander";
import { printTable, formatTimestamp, type Table } from "./format.js";
import { withRuntime, fail, type CommandContext } from "../context.js";

export function registerAnalytics(program: Command): void {
  const analytics = program.command("analytics").description("inspect and manage local usage analytics");

  const ctx = (): CommandContext => {
    const opts = program.opts<{ cwd?: string; config?: string }>();
    return { cwd: opts.cwd ?? process.cwd(), configPath: opts.config };
  };

  analytics
    .command("summary")
    .description("aggregate local analytics summary")
    .option("--json", "output JSON", false)
    .action(async (options: { json?: boolean }) => {
      try {
        await withRuntime(ctx(), async (runtime) => {
          const summary = runtime.analytics.summary();
          if (options.json) {
            console.log(JSON.stringify(summary, null, 2));
            return;
          }
          console.log("MCP Nexus Analytics");
          console.log("");
          console.log(`Servers tracked:      ${summary.serversTracked}`);
          console.log(`Indexed capabilities: ${summary.capabilitiesIndexed}`);
          console.log(`Calls:                ${summary.executionsSucceeded + summary.executionsFailed}`);
          if (summary.successRate !== null) {
            console.log(`Successful:           ${(summary.successRate * 100).toFixed(1)}%`);
          }
          console.log(`Discovery searches:   ${summary.searches}`);
          const conversion = summary.searches > 0 ? summary.searchConversions / summary.searches : 0;
          console.log(`Search to execution:  ${(conversion * 100).toFixed(1)}%`);
          console.log(`Sequences learned:    ${summary.sequencesLearned}`);
          console.log("");
          console.log("All data is stored locally; nothing leaves this machine.");
        });
      } catch (error) {
        fail(error);
      }
    });

  analytics
    .command("tools")
    .description("per-capability usage statistics")
    .option("-n, --limit <n>", "rows to show", parseCount)
    .option("--json", "output JSON", false)
    .action(async (options: { limit?: number; json?: boolean }) => {
      try {
        await withRuntime(ctx(), async (runtime) => {
          const stats = runtime.analytics.toolStats(options.limit);
          if (options.json) {
            console.log(JSON.stringify(stats, null, 2));
            return;
          }
          if (stats.length === 0) {
            console.log("No tool usage recorded yet.");
            return;
          }
          const table: Table = {
            columns: ["CAPABILITY", "CALLS", "OK", "FAIL", "SUCCESS", "AVG LATENCY", "LAST USED"],
            rows: stats.map((stat) => [
              stat.capabilityId,
              String(stat.totalCalls),
              String(stat.successfulCalls),
              String(stat.failedCalls),
              `${(stat.successRate * 100).toFixed(0)}%`,
              `${stat.avgLatencyMs}ms`,
              formatTimestamp(stat.lastUsedAt),
            ]),
          };
          printTable(table);
        });
      } catch (error) {
        fail(error);
      }
    });

  analytics
    .command("sequences")
    .description("learned capability transition sequences")
    .option("--json", "output JSON", false)
    .action(async (options: { json?: boolean }) => {
      try {
        await withRuntime(ctx(), async (runtime) => {
          const sequences = runtime.analytics.sequenceStats();
          if (options.json) {
            console.log(JSON.stringify(sequences, null, 2));
            return;
          }
          if (sequences.length === 0) {
            console.log("No sequences learned yet. They appear after repeated tool usage.");
            return;
          }
          const table: Table = {
            columns: ["FROM", "TO", "OCCURRENCES", "PROBABILITY"],
            rows: sequences.map((stat) => [
              stat.previousCapabilityId,
              stat.nextCapabilityId,
              String(stat.occurrences),
              stat.probability.toFixed(2),
            ]),
          };
          printTable(table);
        });
      } catch (error) {
        fail(error);
      }
    });

  analytics
    .command("reset")
    .description("delete all locally stored analytics data")
    .option("--yes", "skip confirmation prompt", false)
    .action(async (options: { yes?: boolean }) => {
      try {
        if (!options.yes && process.stdin.isTTY) {
          console.log("This deletes usage history, routing stats, and learned sequences.");
          console.log("Re-run with --yes to confirm.");
          return;
        }
        if (!options.yes && !process.stdin.isTTY) {
          throw new Error("Refusing to reset without confirmation. Use --yes.");
        }
        await withRuntime(ctx(), async (runtime) => {
          runtime.analytics.reset();
          console.log("Analytics reset. Configuration and indexes are untouched.");
        });
      } catch (error) {
        fail(error);
      }
    });
}

function parseCount(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid count "${value}"`);
  }
  return parsed;
}
