import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../config/loader.js";
import { Database } from "../../storage/database.js";
import { CapabilityRepository } from "../../storage/capability-repository.js";
import { ServerRepository } from "../../storage/server-repository.js";
import { Registry } from "../../registry/registry.js";
import type { Capability } from "../../models/types.js";

function capabilityFor(serverId: string): Capability {
  return {
    capabilityId: `${serverId}.issues.list`,
    serverId,
    toolName: "list_issues",
    title: "List issues",
    description: "List the issues",
    inputSchemaSummary: { type: "object", properties: {} },
    metadata: { tags: [], keywords: [], risk: "read" },
    availability: "available",
    updatedAt: 1,
  };
}

describe("registry/registry", () => {
  let dir = "";
  let db: Database;
  let registry: Registry;
  let servers: ServerRepository;
  let capabilities: CapabilityRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-nexus-registry-"));
    writeFileSync(
      join(dir, "project-mcp.json"),
      JSON.stringify({ version: 1, servers: { jira: { command: "node", args: ["jira.mjs"] } } }),
    );
    db = new Database(":memory:");
    db.migrate();
    servers = new ServerRepository(db);
    capabilities = new CapabilityRepository(db);
    registry = new Registry(loadConfig({ cwd: dir }), servers, capabilities);
    registry.syncAll(1);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a server at runtime and reports it in summaries", async () => {
    await registry.register({
      id: "github",
      name: "GitHub",
      description: "Code hosting",
      command: "node",
      args: ["github.mjs"],
      env: {},
      tags: ["code"],
      enabled: true,
      alwaysOn: false,
      source: "cli",
    });

    expect(registry.definition("github")?.command).toBe("node");
    expect(servers.get("github")?.name).toBe("GitHub");
    expect(registry.summaries().map((entry) => entry.id).sort()).toEqual(["github", "jira"]);
    expect(registry.source("github")).toBe("cli");
  });

  it("removes a server together with its persisted row and capabilities", async () => {
    capabilities.insert(capabilityFor("jira"));
    expect(capabilities.countForServer("jira")).toBe(1);

    await registry.remove("jira");

    expect(registry.definition("jira")).toBeUndefined();
    expect(servers.get("jira")).toBeUndefined();
    expect(capabilities.countForServer("jira")).toBe(0);
    expect(registry.summaries()).toEqual([]);
  });

  it("syncAll prunes rows for servers that left the config", () => {
    servers.ensureServer("stale", "Stale", "", "stdio", 1);
    capabilities.insert(capabilityFor("stale"));

    registry.syncAll(2);

    expect(servers.get("stale")).toBeUndefined();
    expect(capabilities.countForServer("stale")).toBe(0);
    expect(servers.get("jira")).toBeDefined();
  });
});
