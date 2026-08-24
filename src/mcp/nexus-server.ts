import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Router } from "../router/router.js";
import type { PolicyEngine } from "../router/policies.js";
import type { Registry } from "../registry/registry.js";
import type { CapabilityIndex } from "../index/capability-index.js";
import type { AnalyticsEngine } from "../analytics/analytics-engine.js";
import type { LifecycleManager } from "../lifecycle/lifecycle-manager.js";
import type { Capability } from "../models/types.js";
import type { PromotionMode } from "../config/schema.js";
import { isNexusError } from "../models/errors.js";
import { packageVersion as nexusVersion } from "../utils/version.js";

export const TOOL_NAMES = {
  searchCapabilities: "search_capabilities",
  describeCapabilities: "describe_capabilities",
  executeCapability: "execute_capability",
  searchServers: "search_servers",
} as const;

export const PROMOTED_TOOL_PREFIX = "nexus__";

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

export function promotedToolName(serverId: string, toolName: string): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${PROMOTED_TOOL_PREFIX}${clean(serverId)}__${clean(toolName)}`;
}

function jsonSchemaPropertyToZod(property: unknown): z.ZodType {
  const schema = (property ?? {}) as {
    type?: string;
    description?: string;
    enum?: unknown[];
  };
  let base: z.ZodType;
  switch (schema.type) {
    case "string":
      base = typeof schema.enum === "object" && schema.enum !== null && Array.isArray(schema.enum) && schema.enum.length > 0
        ? z.enum(schema.enum as [string, ...string[]])
        : z.string();
      break;
    case "number":
    case "integer":
      base = z.number();
      break;
    case "boolean":
      base = z.boolean();
      break;
    case "array":
      base = z.array(z.unknown());
      break;
    case "object":
      base = z.record(z.string(), z.unknown());
      break;
    default:
      base = z.unknown();
  }
  if (schema.description) base = base.describe(schema.description);
  return base;
}

function jsonSchemaToZodSchema(input: unknown): z.ZodType {
  const schema = (input ?? {}) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const shape: Record<string, z.ZodType> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    shape[name] = jsonSchemaPropertyToZod(property).optional();
  }
  for (const name of schema.required ?? []) {
    if (shape[name]) {
      shape[name] = jsonSchemaPropertyToZod(schema.properties?.[name]);
    }
  }
  return z.object(shape).passthrough();
}

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
  policies: PolicyEngine;
  lifecycle: Pick<LifecycleManager, "healthAll">;
  promotion: PromotionMode;
}

export function createNexusMcpServer(deps: NexusServerDeps): McpServer {
  const { router, registry, index, analytics, policies, lifecycle, promotion } = deps;
  const promotedNames = new Set<string>();
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

  function promote(capabilities: Capability[]): void {
    if (promotion !== "session" || capabilities.length === 0) return;
    let changed = false;
    for (const capability of capabilities) {
      const decision = policies.evaluate(capability.capabilityId, capability.serverId, capability.metadata.risk);
      if (!decision.allowed) continue;
      const name = promotedToolName(capability.serverId, capability.toolName);
      if (promotedNames.has(name)) continue;
      promotedNames.add(name);
      const riskLabel = `[risk: ${capability.metadata.risk}]`;
      server.registerTool(
        name,
        {
          title: capability.title,
          description: `Promoted from "${capability.serverId}" ${riskLabel}. ${capability.description}`.trim(),
          inputSchema: jsonSchemaToZodSchema(capability.inputSchemaSummary),
        },
        async (rawArgs: unknown) => {
          try {
            const args = (rawArgs ?? {}) as Record<string, unknown>;
            const result = (await router.execute(capability.capabilityId, args, {})) as CallToolResult;
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
      changed = true;
    }
    if (changed) {
      try {
        server.sendToolListChanged();
      } catch {
        // notification is best effort; transport may be mid-negotiation
      }
    }
  }

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
      description:
        "Return the full metadata and input schemas for the given capability IDs." +
        (promotion === "session"
          ? " Described capabilities also become directly callable tools (namespaced nexus__<server>__<tool>) for this session."
          : ""),
      inputSchema: describeInput,
    },
    async ({ capabilityIds }) => {
      try {
        const { found, missing } = await router.describe(capabilityIds);
        promote(found);
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
            serversQuarantined: lifecycle.healthAll().filter((health) => health.quarantined).length,
            capabilitiesIndexed: index.count(),
            analyticsEnabled: analytics.enabled,
            promotion,
            version: nexusVersion(),
          }),
        },
      ],
    }),
  );

  return server;
}
