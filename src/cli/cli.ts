import { Command } from "commander";
import { createRequire } from "node:module";
import { registerServe } from "./commands/serve.js";
import { registerInit } from "./commands/init.js";
import { registerAdd } from "./commands/add.js";
import { registerRemove } from "./commands/remove.js";
import { registerList } from "./commands/list.js";
import { registerStatus } from "./commands/status.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerIndex } from "./commands/index-cmd.js";
import { registerSearch } from "./commands/search.js";
import { registerExec } from "./commands/exec.js";
import { registerAnalytics } from "./commands/analytics.js";
import { registerConfig } from "./commands/config-cmd.js";
import { registerLogs } from "./commands/logs.js";
import { registerImport } from "./commands/import.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("mcp-nexus")
    .description(
      "Local-first intelligent MCP router: connect your AI harness to many MCP servers through one endpoint.",
    )
    .version(packageJsonVersion(), "-V, --version")
    .option("-c, --config <path>", "path to the nexus config file (default: ./project-mcp.json)")
    .option("--cwd <dir>", "working directory (defaults to process cwd)")
    .showSuggestionAfterError();

  const commands = [
    registerServe,
    registerInit,
    registerAdd,
    registerRemove,
    registerList,
    registerStatus,
    registerDoctor,
    registerIndex,
    registerSearch,
    registerExec,
    registerAnalytics,
    registerConfig,
    registerLogs,
    registerImport,
  ];
  for (const register of commands) {
    register(program);
  }
  return program;
}

const require = createRequire(import.meta.url);

function packageJsonVersion(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function runCli(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
