import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNexusMcpServer, TOOL_NAMES } from "../../mcp/nexus-server.js";
import { createRuntime } from "../../runtime/create-runtime.js";
import type { NexusRuntime } from "../../runtime/types.js";
import { createMockTransportFactory, writeProjectConfig, withTempDir } from "../helpers/mock-downstream.js";
import { createLogger } from "../../utils/logger.js";

const SILENT = createLogger("test", { level: "silent" });

async function connectClient(
  runtime: NexusRuntime,
  overrides: Partial<Parameters<typeof createNexusMcpServer>[0]> = {},
): Promise<Client> {
  const server = createNexusMcpServer({
    router: runtime.router,
    registry: runtime.registry,
    index: runtime.index,
    analytics: runtime.analytics,
    policies: runtime.policies,
    lifecycle: runtime.lifecycle,
    promotion: "off",
    ...overrides,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  const client = new Client({ name: "test-harness", version: "0.0.0" }, {});
  await client.connect(clientTransport);
  return client;
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "{}";
}

describe("mcp/nexus-server control plane", () => {
  it("exposes exactly the small control-plane tool surface", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { demo: { command: "mock-demo" } });
      const { factory } = createMockTransportFactory({
        demo: [{ name: "echo", description: "Echo a message" }],
      });
      const runtime = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await runtime.initialize();
      await runtime.startIndexing();
      const client = await connectClient(runtime);

      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        TOOL_NAMES.describeCapabilities,
        TOOL_NAMES.executeCapability,
        TOOL_NAMES.searchCapabilities,
        TOOL_NAMES.searchServers,
      ]);

      await client.close();
      await runtime.shutdown();
    });
  });

  it("serves search -> describe -> execute over the wire", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { demo: { command: "mock-demo" } });
      const { factory } = createMockTransportFactory({
        demo: [{ name: "echo_message", description: "Echo back an important message" }],
      });
      const runtime = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await runtime.initialize();
      await runtime.startIndexing();
      const client = await connectClient(runtime);

      const searched = await client.callTool({
        name: TOOL_NAMES.searchCapabilities,
        arguments: { query: "echo message" },
      });
      const payload = JSON.parse(firstText(searched)) as {
        status: string;
        results: Array<{ capabilityId: string }>;
      };
      expect(payload.status).toBe("ok");
      expect(payload.results[0]?.capabilityId).toBe("demo.echo_message");

      const described = await client.callTool({
        name: TOOL_NAMES.describeCapabilities,
        arguments: { capabilityIds: [payload.results[0]?.capabilityId as string] },
      });
      const describedPayload = JSON.parse(firstText(described)) as {
        capabilities: Array<{ inputSchema: Record<string, unknown> }>;
        missing?: string[];
      };
      expect(describedPayload.capabilities).toHaveLength(1);
      expect(describedPayload.missing).toBeUndefined();

      const executed = await client.callTool({
        name: TOOL_NAMES.executeCapability,
        arguments: { capabilityId: payload.results[0]?.capabilityId, arguments: {} },
      });
      expect(executed.isError).toBeFalsy();
      expect(JSON.stringify(executed.content)).toContain("echo_message");

      await client.close();
      await runtime.shutdown();
    });
  });

  it("returns structured errors instead of throwing over the wire", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, {});
      const runtime = createRuntime({
        cwd: dir,
        logger: SILENT,
        transportFactory: { create: () => { throw new Error("never"); } },
      });
      await runtime.initialize();
      const client = await connectClient(runtime);

      const missing = await client.callTool({
        name: TOOL_NAMES.describeCapabilities,
        arguments: { capabilityIds: ["ghost.tool.get"] },
      });
      const missingPayload = JSON.parse(firstText(missing)) as { status: string; missing: string[] };
      expect(missingPayload.status).toBe("partial");
      expect(missingPayload.missing).toContain("ghost.tool.get");

      const executed = await client.callTool({
        name: TOOL_NAMES.executeCapability,
        arguments: { capabilityId: "ghost.tool.get" },
      });
      expect(executed.isError).toBe(true);
      const errorPayload = JSON.parse(firstText(executed)) as { code: string };
      expect(errorPayload.code).toBe("CAPABILITY_NOT_FOUND");

      await client.close();
      await runtime.shutdown();
    });
  });
});
