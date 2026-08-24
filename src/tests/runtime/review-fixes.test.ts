import { describe, expect, it } from "vitest";
import { createRuntime } from "../../runtime/create-runtime.js";
import { createMockTransportFactory, writeProjectConfig, withTempDir } from "../helpers/mock-downstream.js";
import { createLogger } from "../../utils/logger.js";

const SILENT = createLogger("test");

function tools() {
  return [
    { name: "list_pull_requests", description: "Find and list pull requests for a repository" },
    { name: "get_pull_request", description: "Get a single pull request" },
  ];
}

async function boot(dir: string): Promise<ReturnType<typeof createRuntime>> {
  const { factory } = createMockTransportFactory({ github: tools() });
  const runtime = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
  await runtime.initialize();
  await runtime.startIndexing();
  return runtime;
}

describe("review fixes: end-to-end", () => {
  it("pins feed the ranking signal (C2)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(
        dir,
        { github: { command: "mock-gh" } },
        { routing: { pinnedCapabilities: ["github.pull_request.get"] } },
      );
      const runtime = await boot(dir);
      const results = await runtime.router.search("pull requests");
      expect(results.length).toBeGreaterThan(0);
      const pinned = results.find((match) => match.capabilityId === "github.pull_request.get");
      expect(pinned?.signals.pin).toBe(1);
      expect(pinned?.score).toBeGreaterThanOrEqual(0.97);
      await runtime.shutdown();
    });
  });

  it("soft-deleted tools keep their analytics and stop appearing in search (M4)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh" } });
      const runtime = await boot(dir);
      await runtime.execute("github.pull_request.get", {});
      expect(runtime.analytics.toolStats()[0]?.totalCalls).toBe(1);
      await runtime.shutdown();

      const { factory } = createMockTransportFactory({
        github: [{ name: "list_pull_requests", description: "Find and list pull requests for a repository" }],
      });
      const second = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await second.initialize();
      await second.startIndexing({ force: true });
      expect(second.index.count()).toBe(2);
      expect(second.index.get("github.pull_request.get")?.availability).toBe("unavailable");
      const results = await second.router.search("get pull request");
      expect(results.map((match) => match.capabilityId)).not.toContain("github.pull_request.get");
      const stats = second.analytics.toolStats();
      expect(stats.find((stat) => stat.capabilityId === "github.pull_request.get")?.totalCalls).toBe(1);
      await second.shutdown();
    });
  });

  it("zero-tool servers do not respawn on every boot (M8)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh" } });
      const { factory } = createMockTransportFactory({ github: [] });
      const first = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await first.initialize();
      const firstRun = await first.startIndexing();
      expect(firstRun.map((result) => result.serverId)).toEqual(["github"]);
      await first.shutdown();

      const second = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await second.initialize();
      const secondRun = await second.startIndexing();
      expect(secondRun).toEqual([]);
      await second.shutdown();
    });
  });

  it("idle sweeps never stop a server with in-flight calls (H1)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh" } });
      const { factory } = createMockTransportFactory({
        github: [{ name: "list_pull_requests", description: "list" }],
      });
      const runtime = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await runtime.initialize();
      await runtime.startIndexing();

      const lifecycle = runtime.lifecycle as unknown as {
        inflightCalls: Map<string, number>;
        sweepIdle(): Promise<void>;
      };
      lifecycle.inflightCalls.set("github", 1);
      const stopped: string[] = [];
      const originalStop = lifecycle.sweepIdle.bind(lifecycle);
      void originalStop;

      await (runtime.lifecycle as unknown as { sweepIdle(): Promise<void> }).sweepIdle();
      expect(runtime.lifecycle.isRunning("github")).toBe(true);
      expect(stopped).toEqual([]);
      await runtime.shutdown();
    });
  });

  it("dot-containing server ids resolve for lazy indexing (M1)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { "my.server": { command: "mock-gh" } });
      const { factory } = createMockTransportFactory({
        "my.server": tools(),
      });
      const runtime = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await runtime.initialize();

      const described = await runtime.router.describe(["my.server.pull_requests.list"]);
      expect(described.found).toHaveLength(1);
      expect(described.missing).toEqual([]);
      await runtime.shutdown();
    });
  });
});
