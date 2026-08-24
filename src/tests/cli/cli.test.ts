import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../../cli/cli.js";

const MINI_SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "helpers", "mini-server.mjs");

interface EnvSnapshot {
  key: string;
  value: string | undefined;
}

const envSnapshots: EnvSnapshot[] = [];
let workDir = "";

function snapshotEnv(key: string): void {
  envSnapshots.push({ key, value: process.env[key] });
}

function lastConsoleLine(lines: string[]): string {
  return lines.at(-1) ?? "";
}

function projectConfigPath(): string {
  const candidate = join(workDir, "project-mcp.json");
  expect(existsSync(candidate)).toBe(true);
  return candidate;
}

function readConfigServers(): Record<string, Record<string, unknown>> {
  const config = JSON.parse(readFileSync(projectConfigPath(), "utf8")) as {
    servers?: Record<string, Record<string, unknown>>;
  };
  return config.servers ?? {};
}

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "HOME"]) {
    snapshotEnv(key);
  }
  workDir = mkdtempSync(join(tmpdir(), "mcp-nexus-cli-"));
  const isolatedHome = mkdtempSync(join(tmpdir(), "mcp-nexus-home-"));
  process.env.HOME = isolatedHome;
  process.env.XDG_CONFIG_HOME = join(isolatedHome, ".config");
  process.env.XDG_DATA_HOME = join(isolatedHome, ".local", "share");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workDir, { recursive: true, force: true });
  while (envSnapshots.length > 0) {
    const entry = envSnapshots.pop();
    if (entry && entry.value === undefined) delete process.env[entry.key];
    else if (entry) process.env[entry.key] = entry.value;
  }
});

async function cli(...args: string[]): Promise<string[]> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  try {
    await runCli(["node", "mcp-nexus", "--cwd", workDir, ...args]);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return lines;
}

describe("cli/commands end-to-end", () => {
  it("init creates a config and refuses to clobber without --force", async () => {
    let lines = await cli("init");
    expect(existsSync(projectConfigPath())).toBe(true);
    expect(lines.join("\n")).toContain("Created");

    writeFileSync(projectConfigPath(), JSON.stringify({ version: 1, servers: {} }));
    lines = await cli("init");
    expect(lines.join("\n")).toContain("already exists");

    await cli("init", "--force");
    expect(Object.keys(readConfigServers())).toEqual([]);
  });

  it("add writes a complete definition; remove deletes it again", async () => {
    await cli("add", "mini", "-d", "Mini test server", "-t", "fixture", "-e", "MINI_TOKEN=${MINI_TOKEN}", "--", "node", MINI_SERVER);

    const servers = readConfigServers();
    expect(servers.mini?.command).toBe("node");
    expect(servers.mini?.args).toEqual([MINI_SERVER]);
    expect(servers.mini?.description).toBe("Mini test server");
    expect(servers.mini?.tags).toEqual(["fixture"]);
    expect(servers.mini?.env).toEqual({ MINI_TOKEN: "${MINI_TOKEN}" });

    let lines = await cli("remove", "ghost");
    expect(lines.join("\n")).toContain('"ghost" is not defined');

    lines = await cli("remove", "mini");
    expect(lines.join("\n")).toContain('Removed "mini"');
    expect(readConfigServers().mini).toBeUndefined();
  });

  it("doctor reports ok for a resolvable setup and flags missing env vars", async () => {
    delete process.env.DEFINITELY_UNSET_VAR;
    writeFileSync(
      join(workDir, "project-mcp.json"),
      JSON.stringify({
        version: 1,
        servers: { mini: { command: "node", args: [MINI_SERVER] } },
      }),
    );

    process.exitCode = 0;
    const okLines = await cli("doctor");
    expect(process.exitCode ?? 0).toBe(0);
    expect(okLines.join("\n")).toContain("All checks passed.");

    writeFileSync(
      join(workDir, "project-mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          mini: { command: "node", args: [MINI_SERVER] },
          brokenenv: { command: "node", env: { TOKEN: "${DEFINITELY_UNSET_VAR}" } },
        },
      }),
    );

    process.exitCode = 0;
    const badLines = await cli("doctor");
    expect(process.exitCode).toBe(1);
    expect(badLines.join("\n")).toMatch(/FAIL.*env:brokenenv/);
    process.exitCode = 0;
  });

  it("index, list, search --explain, status, analytics, config path round-trip against a real spawned server", async () => {
    writeFileSync(
      join(workDir, "project-mcp.json"),
      JSON.stringify({
        version: 1,
        servers: { mini: { command: "node", args: [MINI_SERVER], tags: ["fixture"] } },
      }),
    );

    const indexLines = await cli("index");
    expect(indexLines.join("\n")).toContain("mini");
    expect(indexLines.join("\n")).toContain("Total indexed capabilities: 2");

    const listLines = await cli("list");
    expect(listLines.join("\n")).toMatch(/mini\s+(registered|stopped)\s+2/);

    const searchLines = await cli("search", "echo thing", "--explain");
    expect(searchLines.join("\n")).toContain("mini.echo_thing");

    const statusLines = await cli("status", "--json");
    const status = JSON.parse(statusLines.join("\n")) as { capabilitiesIndexed: number };
    expect(status.capabilitiesIndexed).toBe(2);

    const analyticsSummary = await cli("analytics", "summary", "--json");
    const summary = JSON.parse(analyticsSummary.join("\n")) as { capabilitiesIndexed: number };
    expect(summary.capabilitiesIndexed).toBe(2);

    const emptyTools = await cli("analytics", "tools", "--json");
    expect(JSON.parse(emptyTools.join("\n"))).toEqual([]);

    const configLines = await cli("config", "path");
    expect(configLines.join("\n")).toContain(projectConfigPath());

    const templateLines = await cli("config", "template");
    expect(templateLines.join("\n")).toContain('"version": 1');

    const logsBefore = await cli("logs");
    expect(logsBefore.join("\n")).toContain("No log file at");
  });

  it("logs tails the runtime log once it exists", async () => {
    writeFileSync(join(workDir, "project-mcp.json"), JSON.stringify({ version: 1, servers: {} }));
    const logsDir = join(workDir, ".mcp-nexus", "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "runtime.log"), '{"level":"info","msg":"hello from log"}\n');

    const lines = await cli("logs", "-n", "5");
    expect(lines.join("\n")).toContain("hello from log");
  });

  it("analytics reset clears learned state with --yes", async () => {
    writeFileSync(
      join(workDir, "project-mcp.json"),
      JSON.stringify({ version: 1, servers: {} }),
    );
    const lines = await cli("analytics", "reset", "--yes");
    expect(lines.join("\n")).toContain("Analytics reset");
  });

  it("exec runs a capability end-to-end from the CLI", async () => {
    writeFileSync(
      join(workDir, "project-mcp.json"),
      JSON.stringify({
        version: 1,
        servers: { mini: { command: "node", args: [MINI_SERVER] } },
      }),
    );

    const lines = await cli("exec", "mini.echo_thing", "--json");
    const result = JSON.parse(lines.join("\n")) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content?.[0]?.text).toContain("echoed");

    const statsLines = await cli("analytics", "tools", "--json");
    const stats = JSON.parse(statsLines.join("\n")) as Array<{ capabilityId: string; totalCalls: number }>;
    expect(stats.find((stat) => stat.capabilityId === "mini.echo_thing")?.totalCalls).toBe(1);
  });

  it("import pulls mcpServers entries from a generic harness config", async () => {
    const source = join(workDir, "harness.json");
    writeFileSync(
      source,
      JSON.stringify({
        mcpServers: {
          imported: { command: "npx", args: ["-y", "@scope/imported"], env: { K: "${K}" } },
        },
      }),
    );
    await cli("init");

    const lines = await cli("import", source);
    expect(lastConsoleLine(lines)).toContain("Imported 1 server(s)");
    expect(readConfigServers().imported?.command).toBe("npx");

    const again = await cli("import", source);
    expect(again.join("\n")).toContain("Skipped 1 existing");
  });
});
