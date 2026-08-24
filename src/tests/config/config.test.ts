import { describe, expect, it } from "vitest";
import { substituteEnvDeep } from "../../config/env.js";
import { validateConfig, parseConfigFile, loadConfig, type ResolvedConfig } from "../../config/loader.js";
import { dataDirFor, findProjectConfig } from "../../config/paths.js";
import { NexusError } from "../../models/errors.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config/env", () => {
  it("substitutes variables and defaults recursively", () => {
    const env: Record<string, string> = { TOKEN: "t1", HOME: "/h" };
    const lookup = (name: string) => env[name];
    const result = substituteEnvDeep(
      { command: "run", args: ["--home", "${HOME}"], env: { T: "${TOKEN}", D: "${MISSING:-fallback}" } },
      lookup,
    );
    expect(result.value).toEqual({
      command: "run",
      args: ["--home", "/h"],
      env: { T: "t1", D: "fallback" },
    });
    expect(result.missing).toEqual([]);
  });

  it("tracks missing references and keeps placeholders intact", () => {
    const result = substituteEnvDeep({ a: "${NOPE_1}", b: "ok" }, () => undefined);
    expect(result.value).toEqual({ a: "${NOPE_1}", b: "ok" });
    expect(result.missing).toEqual(["NOPE_1"]);
  });
});

describe("config/loader", () => {
  it("validates version and shape", () => {
    expect(() => parseConfigFile({ version: 2 })).toThrow(NexusError);
    expect(() => parseConfigFile([])).toThrow(/JSON object/);
    expect(() => validateConfig({ version: 1, servers: { alpha: {} } })).toThrow(/alpha/);
    const valid = validateConfig({});
    expect(valid.version).toBe(1);
    expect(valid.routing.promotion).toBe("off");
    expect(valid.lifecycle.callTimeoutMs).toBe(120000);
    expect(valid.analytics.enabled).toBe(true);
  });

  it("loads project config with env substitution and source tracking", () => {
    const dir = join(tmpdir(), `mcp-nexus-loader-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "project-mcp.json"),
        JSON.stringify({
          version: 1,
          servers: {
            alpha: { command: "node", tags: ["a"], env: { SECRET: "${NEXUS_TEST_SECRET}" } },
            beta: { command: "bun" },
          },
          routing: { disabledServers: ["beta"], aliases: { pr: "pull request" } },
        }),
        "utf8",
      );
      process.env.NEXUS_TEST_SECRET = "s3cret";
      const config = loadConfig({ cwd: dir });
      delete process.env.NEXUS_TEST_SECRET;

      expect(config.paths.projectConfig).toBe(join(dir, "project-mcp.json"));
      expect(config.servers.alpha?.source).toBe("project");
      expect(config.servers.alpha?.env.SECRET).toBe("s3cret");
      expect(config.servers.alpha?.missingEnvVars).toEqual([]);
      expect(config.servers.beta?.enabled).toBe(false);
      expect(config.routing.aliases.pr).toBe("pull request");
      expect(config.version).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records unresolved env vars without failing the load", () => {
    const dir = join(tmpdir(), `mcp-nexus-loader2-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "project-mcp.json"),
        JSON.stringify({
          version: 1,
          servers: { gamma: { command: "node", env: { NEEDS: "${DEFINITELY_MISSING_VAR_X}" } } },
        }),
        "utf8",
      );
      const config = loadConfig({ cwd: dir });
      expect(config.servers.gamma?.missingEnvVars).toEqual(["DEFINITELY_MISSING_VAR_X"]);
      expect(config.servers.gamma?.env.NEEDS).toBe("${DEFINITELY_MISSING_VAR_X}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid server ids with a clear error", () => {
    const dir = join(tmpdir(), `mcp-nexus-loader3-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "project-mcp.json"),
        JSON.stringify({ version: 1, servers: { "bad/id": { command: "node" } } }),
        "utf8",
      );
      expect(() => loadConfig({ cwd: dir })).toThrow(/Invalid server id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies CLI overrides on top of project config", () => {
    const dir = join(tmpdir(), `mcp-nexus-loader4-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "project-mcp.json"),
        JSON.stringify({ version: 1, servers: { web: { command: "node", tags: ["old"] } } }),
        "utf8",
      );
      const config = loadConfig({
        cwd: dir,
        overrides: { routing: { limit: 5 }, servers: { web: { command: "node", tags: ["new"] } } },
      });
      expect(config.servers.web?.tags).toEqual(["new"]);
      expect(config.routing.limit).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config/paths", () => {
  it("finds project configs walking upward and stops cleanly", () => {
    const root = join(tmpdir(), `mcp-nexus-paths-${Date.now()}`);
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    try {
      writeFileSync(join(root, "nexus.mcp.json"), "{}", "utf8");
      expect(findProjectConfig(nested)).toBe(join(root, "nexus.mcp.json"));
      expect(findProjectConfig(root)).toBe(join(root, "nexus.mcp.json"));
      expect(findProjectConfig(tmpdir())).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("separates project and global data dirs", () => {
    expect(dataDirFor("/w", "project")).toContain(".mcp-nexus");
    expect(dataDirFor("/w", "global")).not.toContain("/w");
  });
});

describe("resolved config invariants", () => {
  it("always exposes database inside data dir", () => {
    const dir = join(tmpdir(), `mcp-nexus-inv-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const config: ResolvedConfig = loadConfig({ cwd: dir });
      expect(config.paths.database.startsWith(config.paths.dataDir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
