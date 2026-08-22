import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPServerDefinition } from "../../models/types.js";
import type { TransportFactory } from "../../mcp/transport-factory.js";

export function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-nexus-test-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

export interface MockToolSpec {
  name: string;
  description?: string;
  handler?: () => unknown;
}

export function createMockTransportFactory(servers: Record<string, MockToolSpec[]>): {
  factory: TransportFactory;
  startedServers(): string[];
} {
  const started: string[] = [];
  const factory: TransportFactory = {
    create(definition: MCPServerDefinition): Transport {
      const specs = servers[definition.id];
      if (!specs) throw new Error(`no mock server registered for "${definition.id}"`);
      started.push(definition.id);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = new McpServer({ name: definition.id, version: "0.0.0-mock" });
      for (const spec of specs) {
        mcp.registerTool(
          spec.name,
          { description: spec.description ?? "" },
          async () => ({
            content: [
              {
                type: "text",
                text:
                  typeof spec.handler === "function"
                    ? JSON.stringify(spec.handler() ?? null)
                    : `mock result of ${spec.name}`,
              },
            ],
          }),
        );
      }
      void mcp.connect(serverTransport);
      return clientTransport;
    },
  };
  return {
    factory,
    startedServers: (): string[] => [...new Set(started)],
  };
}

export function writeProjectConfig(
  dir: string,
  servers: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  const path = join(dir, "project-mcp.json");
  writeFileSync(path, JSON.stringify({ version: 1, servers, ...extra }, null, 2), "utf8");
  return path;
}
