import type { ResolvedConfig, ResolvedServer } from "../config/loader.js";
import { contentHash } from "../utils/hash.js";
import type { CapabilityRepository } from "../storage/capability-repository.js";
import type { ServerRepository } from "../storage/server-repository.js";
import type { ConfigSource, MCPServerDefinition, ServerSummary } from "../models/types.js";

export class Registry {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly servers: ServerRepository,
    private readonly capabilities: CapabilityRepository,
  ) {}

  definition(serverId: string): MCPServerDefinition | undefined {
    return this.config.servers[serverId];
  }

  allDefinitions(): ResolvedServer[] {
    return Object.values(this.config.servers);
  }

  async register(definition: MCPServerDefinition): Promise<void> {
    const resolved = {
      ...definition,
      name: definition.name ?? definition.id,
      description: definition.description ?? "",
      tags: [...definition.tags],
      args: [...definition.args],
      env: { ...definition.env },
      missingEnvVars: [],
    };
    this.config.servers[resolved.id] = resolved;
    this.syncServerRow(resolved);
  }

  async remove(serverId: string): Promise<void> {
    delete this.config.servers[serverId];
    this.capabilities.removeServer(serverId);
    this.servers.remove(serverId);
  }

  async get(serverId: string): Promise<MCPServerDefinition | undefined> {
    return this.definition(serverId);
  }

  async list(): Promise<MCPServerDefinition[]> {
    return this.allDefinitions();
  }

  syncAll(now = Date.now()): void {
    const configured = new Set(Object.keys(this.config.servers));
    for (const definition of Object.values(this.config.servers)) {
      this.syncServerRow(definition, now);
    }
    for (const row of this.servers.list()) {
      if (!configured.has(row.id)) {
        this.capabilities.removeServer(row.id);
        this.servers.remove(row.id);
      }
    }
  }

  private syncServerRow(definition: MCPServerDefinition, now = Date.now()): void {
    this.servers.ensureServer(
      definition.id,
      definition.name ?? definition.id,
      configHashOf(definition),
      "stdio",
      now,
    );
  }

  summaries(): ServerSummary[] {
    return this.allDefinitions().map((definition) => {
      const status = (this.servers.get(definition.id)?.status ?? "registered") as ServerSummary["status"];
      return {
        id: definition.id,
        name: definition.name ?? definition.id,
        description: definition.description ?? "",
        status,
        enabled: definition.enabled,
        alwaysOn: definition.alwaysOn,
        tags: definition.tags,
        transport: "stdio" as const,
        capabilitiesIndexed: this.capabilities.countForServer(definition.id),
        source: definition.source,
      };
    });
  }

  source(serverId: string): ConfigSource {
    return this.config.servers[serverId]?.source ?? "project";
  }
}

export function configHashOf(definition: MCPServerDefinition): string {
  return contentHash({
    command: definition.command,
    args: definition.args,
    cwd: definition.cwd ?? null,
    tags: [...definition.tags].sort(),
    envKeys: Object.keys(definition.env).sort(),
  });
}
