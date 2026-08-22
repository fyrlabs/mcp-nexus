import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { withRuntime, fail } from "../context.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

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
    try {
      execFileSync("test", ["-x", command], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  return whichSync(command) !== null;
}

function looksLikeNpxPackage(definition: { command: string; args: string[] }): boolean {
  const base = commandBaseName(definition.command);
  return base === "npx" || base === "bunx" || base === "pnpm dlx";
}

function commandBaseName(command: string): string {
  return command.split(/[\\/]/).pop() ?? command;
}

function whichSync(command: string): string | null {
  try {
    const output = execFileSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.trim() || null;
  } catch {
    return null;
  }
}
