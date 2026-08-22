import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Router } from "../router/router.js";
import type { Registry } from "../registry/registry.js";
import type { CapabilityIndex } from "../index/capability-index.js";
import type { AnalyticsEngine } from "../analytics/analytics-engine.js";
import { isNexusError } from "../models/errors.js";
import { packageVersion as nexusVersion } from "../utils/version.js";

export const TOOL_NAMES = {
  searchCapabilities: "search_capabilities",
  describeCapabilities: "describe_capabilities",
  executeCapability: "execute_capability",
  searchServers: "search_servers",
} as const;

const searchInput = {
  query: z.string().min(1).describe("Natural language or keyword query describing the capability you need"),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum number of results to return"),
};

const describeInput = {
  capabilityIds: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe("Capability IDs returned by search_capabilities"),
};

const executeInput = {
  capabilityId: z.string().min(1).describe("Capability ID to execute"),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arguments matching the tool's input schema (see describe_capabilities)"),
};

const searchServersInput = {
  query: z.string().min(1).describe("Domain-level query such as 'project management'"),
};

function errorResult(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  if (isNexusError(error)) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ status: "error", ...error.toJSON() }) }],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ status: "error", code: "INTERNAL", message }) },
    ],
  };
}

function jsonContent(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export interface NexusServerDeps {
  router: Router;
  registry: Registry;
  index: CapabilityIndex;
  analytics: AnalyticsEngine;
}

export function createNexusMcpServer(deps: NexusServerDeps): McpServer {
  const { router, registry, index, analytics } = deps;
  const server = new McpServer(
    { name: "mcp-nexus", version: nexusVersion() },
    {
      instructions: [
        "MCP Nexus routes to many downstream MCP servers behind one endpoint.",
        "Workflow: search_capabilities to discover, describe_capabilities to inspect exact input schemas, execute_capability to run.",
        "Do not guess argument shapes: always describe a capability before executing it.",
      ].join(" "),
    },
  );

  server.registerTool(
    TOOL_NAMES.searchCapabilities,
    {
      title: "Search capabilities",
      description:
        "Search every indexed downstream MCP capability by natural language, keywords, tags, server id, or capability id. Returns lightweight metadata only.",
      inputSchema: searchInput,
    },
    async ({ query, limit }) => {
      try {
        const results = await router.search(query, { limit });
        return jsonContent({
          status: results.length > 0 ? "ok" : "no_results",
          results,
          hint:
            results.length > 0
              ? "Use describe_capabilities with the returned capabilityIds before executing."
              : "Try broader keywords or search_servers to explore domains.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.describeCapabilities,
    {
      title: "Describe capabilities",
      description: "Return the full metadata and input schemas for the given capability IDs.",
      inputSchema: describeInput,
    },
    async ({ capabilityIds }) => {
      try {
        const { found, missing } = await router.describe(capabilityIds);
        return jsonContent({
          status: missing.length === 0 ? "ok" : "partial",
          capabilities: found.map((capability) => ({
            capabilityId: capability.capabilityId,
            serverId: capability.serverId,
            toolName: capability.toolName,
            title: capability.title,
            description: capability.description,
            risk: capability.metadata.risk,
            availability: capability.availability,
            inputSchema: capability.inputSchemaSummary,
          })),
          missing: missing.length > 0 ? missing : undefined,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.executeCapability,
    {
      title: "Execute capability",
      description:
        "Execute a downstream MCP capability by ID. The underlying server is started on demand and the arguments are forwarded verbatim.",
      inputSchema: executeInput,
    },
    async ({ capabilityId, arguments: args }) => {
      try {
        const result = (await router.execute(capabilityId, args, {})) as CallToolResult;
        if (Array.isArray(result.content)) {
          return result.isError
            ? { content: result.content, isError: true }
            : { content: result.content };
        }
        return jsonContent({ status: "ok", result });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.searchServers,
    {
      title: "Search servers",
      description:
        "Rank configured downstream MCP servers against a domain-level query. Useful before drilling into capability search.",
      inputSchema: searchServersInput,
    },
    async ({ query }) => {
      try {
        const ranked = await router.searchServers(query);
        return jsonContent({
          status: ranked.length > 0 ? "ok" : "no_results",
          servers: ranked.map((entry) => ({
            serverId: entry.serverId,
            name: registry.definition(entry.serverId)?.name ?? entry.serverId,
            score: entry.score,
            topCapabilities: entry.topCapabilities.slice(0, 5),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerResource(
    "status",
    "nexus://status",
    { mimeType: "application/json" },
    async () => ({
      contents: [
        {
          uri: "nexus://status",
          mimeType: "application/json",
          text: JSON.stringify({
            servers: registry.allDefinitions().length,
            capabilitiesIndexed: index.count(),
            analyticsEnabled: analytics.enabled,
            version: nexusVersion(),
          }),
        },
      ],
    }),
  );

  return server;
}
