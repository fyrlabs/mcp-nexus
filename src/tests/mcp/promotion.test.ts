import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createNexusMcpServer, promotedToolName } from "../../mcp/nexus-server.js";
import { createRuntime } from "../../runtime/create-runtime.js";
import type { NexusRuntime } from "../../runtime/types.js";
import { createMockTransportFactory, writeProjectConfig, withTempDir } from "../helpers/mock-downstream.js";
import { createLogger } from "../../utils/logger.js";

const SILENT = createLogger("test", { level: "silent" });

async function connectClient(runtime: NexusRuntime): Promise<Client> {
  const server = createNexusMcpServer({
    router: runtime.router,
    registry: runtime.registry,
    index: runtime.index,
    analytics: runtime.analytics,
    policies: runtime.policies,
    lifecycle: runtime.lifecycle,
    promotion: runtime.config.routing.promotion,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  const client = new Client({ name: "test-harness", version: "0.0.0" }, {});
  await client.connect(clientTransport);
  return client;
}

describe("mcp promotion (mode B)", () => {
  it("namespaces promoted tools and sanitizes invalid characters", () => {
    expect(promotedToolName("demo", "echo_message")).toBe("nexus__demo__echo_message");
    expect(promotedToolName("my.server", "get-thing.v2")).toBe("nexus__my_server__get-thing_v2");
  });

  it("off by default: describing does not add tools", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(dir, { demo: { command: "mock-demo" } });
      const { factory } = createMockTransportFactory({
        demo: [{ name: "echo_message", description: "Echo back an important message" }],
      });
      const runtime = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await runtime.initialize();
      await runtime.startIndexing();
      const client = await connectClient(runtime);

      const before = await client.listTools();
      expect(before.tools).toHaveLength(4);

      await client.callTool({
        name: "describe_capabilities",
        arguments: { capabilityIds: ["demo.echo_message"] },
      });
      const after = await client.listTools();
      expect(after.tools).toHaveLength(4);

      await client.close();
      await runtime.shutdown();
    });
  });

  it("session mode: describing promotes the tool, notifies, and executes downstream", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(
        dir,
        { demo: { command: "mock-demo" } },
        { routing: { promotion: "session" } },
      );
      const { factory } = createMockTransportFactory({
        demo: [{ name: "echo_message", description: "Echo back an important message" }],
      });
      const runtime = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await runtime.initialize();
      await runtime.startIndexing();
      const client = await connectClient(runtime);

      const notifications: string[] = [];
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        notifications.push("changed");
      });

      const described = await client.callTool({
        name: "describe_capabilities",
        arguments: { capabilityIds: ["demo.echo_message"] },
      });
      expect(described.isError).toBeFalsy();

      const promoted = promotedToolName("demo", "echo_message");
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === promoted);
      expect(tool).toBeDefined();
      expect(tool?.description).toContain("[risk:");
      expect(notifications.length).toBeGreaterThan(0);

      const executed = await client.callTool({ name: promoted, arguments: {} });
      expect(executed.isError).toBeFalsy();
      expect(JSON.stringify(executed.content)).toContain("echo_message");

      await client.close();
      await runtime.shutdown();
    });
  });

  it("policy-denied capabilities are never promoted", async () => {
    await withTempDir(async (dir) => {
      writeProjectConfig(
        dir,
        { demo: { command: "mock-demo" } },
        {
          routing: {
            promotion: "session",
            policies: { destructive: "deny", write: "allow", read: "allow", unknown: "allow" },
          },
        },
      );
      const { factory } = createMockTransportFactory({
        demo: [
          { name: "delete_everything", description: "Delete all the things permanently" },
          { name: "echo_message", description: "Echo back an important message" },
        ],
      });
      const runtime = createRuntime({ cwd: dir, logger: SILENT, transportFactory: factory });
      await runtime.initialize();
      await runtime.startIndexing();
      const client = await connectClient(runtime);

      await client.callTool({
        name: "describe_capabilities",
        arguments: { capabilityIds: ["demo.everything.delete", "demo.echo_message"] },
      });

      const tools = await client.listTools();
      const names = tools.tools.map((entry) => entry.name);
      expect(names).toContain(promotedToolName("demo", "echo_message"));
      expect(names).not.toContain(promotedToolName("demo", "delete_everything"));

      await client.close();
      await runtime.shutdown();
    });
  });
});
