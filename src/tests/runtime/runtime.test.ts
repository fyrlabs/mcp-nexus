import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRuntime } from "../../runtime/create-runtime.js";
import type { NexusRuntime } from "../../runtime/types.js";
import { createMockTransportFactory, writeProjectConfig, withTempDir, type MockToolSpec } from "../helpers/mock-downstream.js";
import { createLogger } from "../../utils/logger.js";

const SILENT = createLogger("test", { level: "silent" });

function githubTools(): MockToolSpec[] {
  return [
    { name: "list_pull_requests", description: "Find and list pull requests using repository, state, author, reviewer, and label filters." },
    { name: "get_pull_request", description: "Get a single pull request with full details." },
    { name: "list_review_comments", description: "List review comments left on a pull request." },
    { name: "delete_repository", description: "Delete a repository permanently. This cannot be undone." },
  ];
}

function jiraTools(): MockToolSpec[] {
  return [
    { name: "search_issues", description: "Search Jira issues with JQL filters and return matching tickets." },
    { name: "get_issue", description: "Fetch a single issue by key." },
  ];
}

async function bootRuntime(dir: string): Promise<NexusRuntime> {
  const { factory } = createMockTransportFactory({
    github: githubTools(),
    jira: jiraTools(),
  });
  const runtime = createRuntime({
    cwd: dir,
    logger: SILENT,
    transportFactory: factory,
  });
  await runtime.initialize();
  await runtime.startIndexing();
  return runtime;
}

describe("runtime end-to-end (mock downstreams)", () => {
  it("quarantines a repeatedly failing server, hides it from routing, and remembers across restarts", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(
        dir,
        { github: { command: "mock-gh" }, jira: { command: "mock-jira" } },
        { lifecycle: { quarantineThreshold: 2, quarantineBackoffMs: 60_000, quarantineMaxBackoffMs: 60_000 } },
      );
      const { factory } = createMockTransportFactory({ github: githubTools(), jira: jiraTools() });

      const firstBoot = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await firstBoot.initialize();
      await firstBoot.startIndexing();
      const healthy = await firstBoot.router.search("pull requests");
      expect(healthy.some((match) => match.serverId === "github")).toBe(true);
      expect(firstBoot.lifecycle.health("github")).toMatchObject({ consecutiveFailures: 0, score: 1 });
      await firstBoot.shutdown();

      const brokenFactory = {
        create: (definition: { id: string }) => {
          if (definition.id === "github") throw new Error("spawn mock-gh ENOENT");
          return factory.create(definition as never);
        },
      };
      const secondBoot = createRuntime({ cwd: dir, logger: SILENT, transportFactory: brokenFactory as never });
      await secondBoot.initialize();
      await expect(secondBoot.execute("github.pull_requests.list", {})).rejects.toMatchObject({
        code: "MCP_START_FAILED",
      });
      await expect(secondBoot.execute("github.pull_requests.list", {})).rejects.toMatchObject({
        code: "MCP_START_FAILED",
      });
      expect(secondBoot.lifecycle.isQuarantined("github")).toBe(true);
      await expect(secondBoot.execute("github.pull_requests.list", {})).rejects.toMatchObject({
        code: "MCP_QUARANTINED",
      });
      await secondBoot.shutdown();

      let spawnAttempts = 0;
      const countingFactory = {
        create: (definition: { id: string }) => {
          spawnAttempts++;
          return factory.create(definition as never);
        },
      };
      const thirdBoot = createRuntime({ cwd: dir, logger: SILENT, transportFactory: countingFactory as never });
      await thirdBoot.initialize();
      expect(thirdBoot.lifecycle.isQuarantined("github")).toBe(true);
      expect(thirdBoot.lifecycle.health("github")).toMatchObject({ consecutiveFailures: 2, score: 0 });
      await expect(thirdBoot.execute("github.pull_requests.list", {})).rejects.toMatchObject({
        code: "MCP_QUARANTINED",
      });
      expect(spawnAttempts).toBe(0);

      const afterQuarantine = await thirdBoot.router.search("issues");
      expect(afterQuarantine.every((match) => match.serverId !== "github")).toBe(true);
      expect(afterQuarantine.some((match) => match.serverId === "jira")).toBe(true);
      await thirdBoot.shutdown();
    });
  });

  it("indexes multiple servers behind one nexus endpoint without starting them at boot (spec scenario C)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh" }, jira: { command: "mock-jira" } });
      const { factory } = createMockTransportFactory({ github: githubTools(), jira: jiraTools() });
      const runtime = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await runtime.initialize();
      expect(runtime.lifecycle.runningCount()).toBe(0);
      expect(runtime.index.count()).toBe(0);

      await runtime.startIndexing();
      expect(runtime.index.count()).toBe(6);
      expect(runtime.index.get("github.pull_requests.list")?.toolName).toBe("list_pull_requests");
      expect(runtime.index.get("jira.issues.search")).toBeDefined();

      const secondBoot = createRuntime({
        cwd: dir,
        logger: SILENT,
        transportFactory: factory,
      });
      await secondBoot.initialize();
      expect(secondBoot.index.count()).toBe(6);
      expect(secondBoot.lifecycle.runningCount()).toBe(0);
      await secondBoot.shutdown();
      await runtime.shutdown();
    });
  });

  it("search returns relevant capabilities with metadata only, no schemas", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh" }, jira: { command: "mock-jira" } });
      const runtime = await bootRuntime(dir);
      const results = await runtime.router.search("find comments people left on my PR");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.capabilityId).toBe("github.review_comments.list");
      expect(results[0]?.signals.exact).toBe(0);
      expect(results[0]?.score).toBeGreaterThan(0.05);
      expect(JSON.stringify(results)).not.toContain("inputSchema");
      expect(JSON.stringify(results)).not.toContain("GITHUB_TOKEN");
      await runtime.shutdown();
    });
  });

  it("executes a capability by lazily starting the owning server (spec scenario D)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh" } });
      const runtime = await bootRuntime(dir);

      const described = await runtime.router.describe(["github.pull_requests.list"]);
      expect(described.missing).toEqual([]);
      expect(Object.keys(described.found[0]?.inputSchemaSummary ?? {})).toContain("type");

      const result = (await runtime.execute("github.pull_requests.list", {})) as {
        content?: Array<{ text?: string }>;
      };
      expect(result.content?.[0]?.text).toContain("list_pull_requests");
      expect(runtime.lifecycle.status("github")).toBe("running");
      await runtime.shutdown();
    });
  });

  it("records local analytics that survive restarts (spec scenario E)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh" } });
      const first = await bootRuntime(dir);
      await first.execute("github.pull_requests.list", {});
      const summaryBefore = first.analytics.summary();
      expect(summaryBefore.executionsSucceeded + summaryBefore.executionsFailed).toBe(1);
      await first.shutdown();

      const second = await bootRuntime(dir);
      const stats = second.analytics.toolStats();
      expect(stats.find((stat) => stat.capabilityId === "github.pull_requests.list")?.totalCalls).toBe(1);
      await second.shutdown();
    });
  });

  it("improves ranking of repeatedly used capabilities (spec scenario F)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh" }, jira: { command: "mock-jira" } });
      const runtime = await bootRuntime(dir);
      const query = "search issues";

      const before = await runtime.router.search(query, { sessionId: "learner" });
      const topBefore = before[0]?.capabilityId;
      expect(topBefore).toBeDefined();

      for (let i = 0; i < 12; i++) {
        await runtime.execute(topBefore as string, {}, { sessionId: "learner" });
      }

      const after = await runtime.router.search(query, { sessionId: "other" });
      expect(after[0]?.capabilityId).toBe(topBefore);
      expect(after[0]?.signals.userAffinity).toBeGreaterThan(0);
      await runtime.shutdown();
    });
  });

  it("never selects blocked capabilities but still serves the rest (spec scenario G)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(
        dir,
        { github: { command: "mock-gh" } },
        { routing: { disabledCapabilities: ["github.repository.delete"] } },
      );
      const runtime = await bootRuntime(dir);

      await expect(runtime.execute("github.repository.delete", {})).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      const results = await runtime.router.search("delete repository");
      expect(results.map((match) => match.capabilityId)).not.toContain("github.repository.delete");

      const described = await runtime.router.describe(["github.repository.delete"]);
      expect(described.found).toEqual([]);
      expect(described.missing).toContain("github.repository.delete");

      await expect(runtime.router.searchServers("pull requests")).resolves.toBeDefined();
      await runtime.shutdown();
    });
  });

  it("reindexes when the server definition changes across restarts", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh-v1" } });
      const first = await bootRuntime(dir);
      await first.shutdown();

      writeProjectConfig(dir, { github: { command: "mock-gh-v2", tags: ["changed"] } });
      const secondRuntime = await (async () => {
        const { factory } = createMockTransportFactory({ github: githubTools() });
        const runtime = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
        await runtime.initialize();
        return runtime;
      })();
      const refreshed = await secondRuntime.startIndexing({ force: false });
      expect(refreshed.map((result) => result.serverId)).toEqual(["github"]);
      expect(secondRuntime.index.count()).toBe(githubTools().length);
      await secondRuntime.shutdown();
    });
  });

  it("keeps working after deleting learned state (.mcp-nexus) (spec scenario J)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh" } });
      const first = await bootRuntime(dir);
      await first.execute("github.pull_requests.list", {});
      await first.shutdown();

      rmSync(join(dir, ".mcp-nexus"), { recursive: true, force: true });
      const second = await bootRuntime(dir);
      expect(second.analytics.summary().executionsSucceeded ?? 0).toBe(0);
      expect(second.analytics.summary().executionsFailed).toBe(0);
      await second.execute("github.pull_requests.list", {});
      await second.shutdown();
    });
  });

  it("search keeps serving persisted metadata while execution fails cleanly (spec scenarios H + fallback)", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { github: { command: "mock-gh" } });
      const healthy = await bootRuntime(dir);
      await healthy.shutdown();

      const failingFactory = {
        create: () => {
          throw new Error("spawn ENOENT");
        },
      };
      const broken = createRuntime({ cwd: dir, logger: SILENT, transportFactory: failingFactory });
      await broken.initialize();

      const results = await broken.router.search("list pull requests");
      expect(results[0]?.capabilityId).toBe("github.pull_requests.list");
      await expect(broken.execute("github.pull_requests.list", {})).rejects.toMatchObject({
        code: "MCP_START_FAILED",
      });
      expect(broken.index.get("github.pull_requests.list")?.availability).toBe("unavailable");
      await broken.shutdown();
    });
  });
});
