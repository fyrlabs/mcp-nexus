import type { Command } from "commander";
import { constants as fsConstants, accessSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { withRuntime, fail } from "../context.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const WINDOWS = process.platform === "win32";
const PATH_EXTENSIONS = WINDOWS
  ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
  : [""];

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("validate configuration, environment references, commands, and database health")
    .action(async () => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      const checks: Check[] = [];
      try {
        await withRuntime({ cwd: opts.cwd ?? process.cwd(), configPath: opts.config }, async (runtime) => {
          checks.push({
            name: "config",
            ok: true,
            detail: runtime.config.paths.projectConfig ?? "no project config; defaults in use",
          });
          checks.push({
            name: "database",
            ok: true,
            detail: runtime.config.paths.database,
          });
          for (const health of runtime.lifecycle.healthAll()) {
            if (!health.quarantined) continue;
            const retryInMs = Math.max(0, (health.quarantinedUntil ?? 0) - Date.now());
            checks.push({
              name: `health:${health.serverId}`,
              ok: false,
              detail:
                `quarantined after ${health.consecutiveFailures} consecutive failures ` +
                `(last: ${health.lastFailureCode ?? "unknown"}); retrying in ${Math.ceil(retryInMs / 1000)}s`,
            });
          }
          for (const definition of runtime.registry.allDefinitions()) {
            if (definition.missingEnvVars.length > 0) {
              checks.push({
                name: `env:${definition.id}`,
                ok: false,
                detail: `missing variables: ${definition.missingEnvVars.join(", ")}`,
              });
            } else {
              checks.push({ name: `env:${definition.id}`, ok: true, detail: "all references resolve" });
            }
            const commandOk = isExecutable(definition.command);
            checks.push({
              name: `command:${definition.id}`,
              ok: commandOk,
              detail: commandOk ? definition.command : `"${definition.command}" not found on PATH`,
            });
            if (!commandOk && looksLikeNpxPackage(definition)) {
              checks.push({
                name: `note:${definition.id}`,
                ok: true,
                detail: "npx will download this package on first start",
              });
            }
          }
        });
      } catch (error) {
        fail(error);
      }

      let failures = 0;
      console.log("MCP Nexus Doctor");
      console.log("");
      for (const check of checks) {
        const mark = check.ok ? "ok  " : "FAIL";
        if (!check.ok) failures++;
        console.log(`  [${mark}] ${check.name.padEnd(24)} ${check.detail}`);
      }
      console.log("");
      console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
      if (failures > 0) process.exitCode = 1;
    });
}

function isExecutable(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) {
    return isFileExecutable(command);
  }
  return whichSync(command) !== null;
}

function isFileExecutable(candidate: string): boolean {
  try {
    statSync(candidate);
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function looksLikeNpxPackage(definition: { command: string; args: string[] }): boolean {
  const base = commandBaseName(definition.command).toLowerCase();
  return base === "npx" || base === "npx.cmd" || base === "bunx" || base === "pnpm";
}

function commandBaseName(command: string): string {
  return command.split(/[\\/]/).pop() ?? command;
}

function whichSync(command: string): string | null {
  const pathVariable = process.env.PATH ?? "";
  for (const dir of pathVariable.split(delimiter)) {
    if (!dir) continue;
    for (const extension of PATH_EXTENSIONS) {
      const candidate = join(dir, `${command}${extension}`);
      try {
        statSync(candidate);
        return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

