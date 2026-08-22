import type { Command } from "commander";
import { printTable, type Table } from "./format.js";
import { withRuntime, fail } from "../context.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("show nexus configuration, index health, and running servers")
    .option("--json", "output JSON", false)
    .action(async (options: { json?: boolean }) => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      try {
        await withRuntime({ cwd: opts.cwd ?? process.cwd(), configPath: opts.config }, async (runtime) => {
          const summaries = runtime.registry.summaries();
          const running = runtime.lifecycle.statuses();
          const payload = {
            configPath: runtime.config.paths.projectConfig,
            dataDir: runtime.config.paths.dataDir,
            database: runtime.config.paths.database,
            serversTotal: summaries.length,
            serversRunning: running.filter((entry) => entry.status === "running").length,
            capabilitiesIndexed: runtime.index.count(),
            analyticsEnabled: runtime.analytics.enabled,
            servers: summaries.map((entry) => ({
              id: entry.id,
              status: entry.status,
              enabled: entry.enabled,
              capabilitiesIndexed: entry.capabilitiesIndexed,
              source: entry.source,
            })),
          };
          if (options.json) {
            console.log(JSON.stringify(payload, null, 2));
            return;
          }
          console.log("MCP Nexus Status");
          console.log("");
          console.log(`Config:      ${payload.configPath ?? "(none found; defaults only)"}`);
          console.log(`Data dir:    ${payload.dataDir}`);
          console.log(`Database:    ${payload.database}`);
          console.log(`Servers:     ${payload.serversTotal} (${payload.serversRunning} running)`);
          console.log(`Capabilities indexed: ${payload.capabilitiesIndexed}`);
          console.log(`Analytics:   ${payload.analyticsEnabled ? "enabled (local only)" : "disabled"}`);
          if (summaries.length > 0) {
            console.log("");
            const table: Table = {
              columns: ["SERVER", "STATUS", "CAPS", "ENABLED"],
              rows: summaries.map((entry) => [
                entry.id,
                entry.status,
                String(entry.capabilitiesIndexed),
                entry.enabled ? "yes" : "no",
              ]),
            };
            printTable(table);
          }
        });
      } catch (error) {
        fail(error);
      }
    });
}
