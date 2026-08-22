import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createRuntime } from "../../runtime/create-runtime.js";
import type { NexusRuntime } from "../../runtime/types.js";
import { writeProjectConfig, withTempDir } from "../helpers/mock-downstream.js";
import { createLogger } from "../../utils/logger.js";

const require = createRequire(import.meta.url);
const SILENT = createLogger("test", { level: "silent" });

function resolveEverythingServer(): string | null {
  try {
    const pkgPath = require.resolve("@modelcontextprotocol/server-everything/package.json") as string;
    const pkg = require(pkgPath) as { main?: string; bin?: string | Record<string, string> };
    const dir = pkgPath.replace(/package\.json$/, "");
    const entry =
      (typeof pkg.bin === "string" ? pkg.bin : undefined) ??
      (pkg.bin && typeof pkg.bin === "object" ? Object.values(pkg.bin)[0] : undefined) ??
      pkg.main;
    if (!entry) return null;
    return `${dir}${entry}`.replace(/^file:/, "");
  } catch {
    return null;
  }
}

const serverPath = resolveEverythingServer();

describe("integration with a real downstream MCP (@modelcontextprotocol/server-everything)", () => {
  it.skipIf(serverPath === null)(
    "lazily indexes a real stdio server without starting it at boot (spec scenarios A/B/C)",
    async () => {
      await withTempDir(async (dir) => {
        writeProjectConfig(dir, {
          everything: { command: process.execPath, args: [serverPath as string] },
        });
        const runtime: NexusRuntime = createRuntime({ cwd: dir, logger: SILENT });
        await runtime.initialize();
        expect(runtime.index.count()).toBe(0);
        expect(runtime.lifecycle.runningCount()).toBe(0);

        await runtime.startIndexing();
        expect(runtime.index.count()).toBeGreaterThan(5);

        const results = await runtime.router.search("echo back a message");
        expect(results[0]?.capabilityId).toBe("everything.echo");
        await runtime.shutdown();
      });
    },
    60_000,
  );

  it.skipIf(serverPath === null)(
    "executes a real tool through nexus with analytics recorded",
    async () => {
      await withTempDir(async (dir) => {
        writeProjectConfig(dir, {
          everything: { command: process.execPath, args: [serverPath as string] },
        });
        const runtime: NexusRuntime = createRuntime({ cwd: dir, logger: SILENT });
        await runtime.initialize();
        await runtime.startIndexing();

        const described = await runtime.router.describe(["everything.echo"]);
        expect(described.missing).toEqual([]);

        const executed = (await runtime.execute("everything.echo", {
          message: "hello from mcp-nexus",
        })) as { content?: Array<{ text?: string }>; isError?: boolean };
        expect(executed.isError).toBeFalsy();
        expect(JSON.stringify(executed.content)).toContain("hello from mcp-nexus");

        expect(runtime.analytics.summary().executionsSucceeded).toBe(1);
        expect(runtime.analytics.toolStats()[0]?.capabilityId).toBe("everything.echo");

        await runtime.shutdown();
      });
    },
    60_000,
  );
});
