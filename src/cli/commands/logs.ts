import type { Command } from "commander";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataDirFor, findProjectConfig, logsDirFor } from "../../config/paths.js";
import { fail } from "../context.js";

export function registerLogs(program: Command): void {
  program
    .command("logs")
    .description("show recent runtime log lines (written while `mcp-nexus serve` runs)")
    .option("-f, --follow", "keep the stream open", false)
    .option("-n, --lines <n>", "number of lines to show", "50")
    .action(async (options: { follow?: boolean; lines: string }) => {
      try {
        const opts = program.opts<{ cwd?: string }>();
        const baseDir = resolve(opts.cwd ?? process.cwd());
        const projectConfig = findProjectConfig(baseDir);
        const projectRoot = projectConfig ? dirname(projectConfig) : baseDir;
        const dataDir = dataDirFor(projectRoot, projectConfig !== null ? "project" : "global");
        const logPath = join(logsDirFor(dataDir), "runtime.log");

        if (!existsSync(logPath)) {
          console.log(`No log file at ${logPath}.`);
          console.log("Logs are written automatically while `mcp-nexus serve` runs.");
          return;
        }
        const count = Number.parseInt(options.lines, 10);
        for (const line of readTail(logPath, Number.isFinite(count) && count > 0 ? count : 50)) {
          console.log(line);
        }
        if (options.follow) {
          await followFile(logPath);
        }
      } catch (error) {
        fail(error);
      }
    });
}

function readTail(path: string, count: number): string[] {
  const all = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  return all.slice(Math.max(0, all.length - count));
}

async function followFile(path: string): Promise<void> {
  let position = statSync(path).size;
  await new Promise<never>(() => {
    setInterval(() => {
      let current: number;
      try {
        current = statSync(path).size;
      } catch {
        return;
      }
      if (current <= position) return;
      const stream = createReadStream(path, { start: position, end: current - 1, encoding: "utf8" });
      stream.on("data", (chunk) => process.stdout.write(String(chunk)));
      stream.on("close", () => {
        position = current;
      });
    }, 500);
  });
}
