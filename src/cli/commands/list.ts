import type { Command } from "commander";
import { printTable, type Table } from "./format.js";
import { withRuntime, fail } from "../context.js";

export function registerList(program: Command): void {
  program
    .command("list")
    .description("list configured downstream MCP servers and their index state")
    .option("--json", "output JSON", false)
    .action(async (options: { json?: boolean }) => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      const ctx = { cwd: opts.cwd ?? process.cwd(), configPath: opts.config };
      try {
        const runtime = await withRuntime(ctx, async (rt) => rt.registry.summaries());
        if (options.json) {
          console.log(JSON.stringify(runtime, null, 2));
          return;
        }
        if (runtime.length === 0) {
          console.log("No downstream servers configured. Run `mcp-nexus add <name> -- <command>`.");
          return;
        }
        const table: Table = {
          columns: ["ID", "STATUS", "CAPS", "ENABLED", "SOURCE", "TAGS"],
          rows: runtime.map((entry) => [
            entry.id,
            entry.status,
            String(entry.capabilitiesIndexed),
            entry.enabled ? "yes" : "no",
            entry.source,
            entry.tags.join(","),
          ]),
        };
        printTable(table);
      } catch (error) {
        fail(error);
      }
    });
}
