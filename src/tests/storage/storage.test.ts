import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Database } from "../../storage/database.js";
import { CapabilityRepository } from "../../storage/capability-repository.js";
import { ServerRepository } from "../../storage/server-repository.js";
import { AnalyticsRepository } from "../../storage/analytics-repository.js";
import type { Capability } from "../../models/types.js";

function makeCapability(id: string, serverId = "srv"): Capability {
  return {
    capabilityId: id,
    serverId,
    toolName: id.replace(/\./g, "_"),
    title: `Title ${id}`,
    description: `Description of ${id}`,
    inputSchemaSummary: { type: "object", properties: { a: { type: "string" } } },
    metadata: { tags: ["mcp"], keywords: ["alpha"], risk: "read" },
    availability: "available",
    updatedAt: Date.now(),
  };
}

describe("storage/database", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.migrate();
  });
  afterEach(() => db.close());

  it("applies migrations once and reports schema version", () => {
    expect(db.schemaVersion).toBe(4);
    db.migrate();
    expect(db.schemaVersion).toBe(4);
  });

  it("supports transactions with rollback on failure", () => {
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO servers (id, created_at, updated_at) VALUES ('x', 1, 1)");
        throw new Error("rollback me");
      }),
    ).toThrow("rollback me");
    expect(db.get("SELECT * FROM servers WHERE id = 'x'")).toBeUndefined();
  });
});

describe("storage/server-repository", () => {
  let db: Database;
  let servers: ServerRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    db.migrate();
    servers = new ServerRepository(db);
  });
  afterEach(() => db.close());

  it("upserts servers keeping the last-indexed config hash until reindexed", () => {
    servers.ensureServer("gh", "GitHub", "hash-1");
    const first = servers.get("gh");
    expect(first?.status).toBe("registered");
    servers.ensureServer("gh", "GitHub", "hash-2");
    const afterRelabel = servers.get("gh");
    expect(afterRelabel?.configHash).toBe("hash-1");
    expect(afterRelabel?.name).toBe("GitHub");
    servers.setConfigHash("gh", "hash-2");
    expect(servers.get("gh")?.configHash).toBe("hash-2");
    const created = first?.createdAt;
    expect(servers.get("gh")?.createdAt).toBe(created);
  });

  it("persists quarantine health and defaults it to clean for new rows", () => {
    servers.ensureServer("gh", "GitHub", "h");
    expect(servers.get("gh")).toMatchObject({
      consecutiveFailures: 0,
      quarantinedUntil: null,
      lastFailureAt: null,
      lastFailureCode: null,
    });
    servers.setHealth(
      "gh",
      { consecutiveFailures: 3, quarantinedUntil: 9000, lastFailureAt: 8000, lastFailureCode: "MCP_START_FAILED" },
      8000,
    );
    expect(servers.get("gh")).toMatchObject({
      consecutiveFailures: 3,
      quarantinedUntil: 9000,
      lastFailureAt: 8000,
      lastFailureCode: "MCP_START_FAILED",
      updatedAt: 8000,
    });
    servers.setHealth(
      "gh",
      { consecutiveFailures: 0, quarantinedUntil: null, lastFailureAt: 8000, lastFailureCode: "MCP_START_FAILED" },
      9500,
    );
    expect(servers.get("gh")?.quarantinedUntil).toBeNull();
  });

  it("tracks lifecycle timestamps", () => {
    servers.ensureServer("gl", "GitLab", "h");
    servers.markStarted("gl", 1000);
    expect(servers.get("gl")?.status).toBe("starting");
    servers.markConnected("gl", 1500);
    const record = servers.get("gl");
    expect(record?.status).toBe("running");
    expect(record?.lastStartedAt).toBe(1000);
    expect(record?.lastConnectedAt).toBe(1500);
    expect(servers.list()).toHaveLength(1);
  });
});

describe("storage/capability-repository", () => {
  let db: Database;
  let capabilities: CapabilityRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    db.migrate();
    new ServerRepository(db).ensureServer("srv", "Srv", "h");
    capabilities = new CapabilityRepository(db);
  });
  afterEach(() => db.close());

  it("soft-deletes vanished tools, keeping rows unavailable for analytics", () => {
    capabilities.replaceServerCapabilities("srv", [makeCapability("srv.a.get"), makeCapability("srv.b.list")]);
    expect(capabilities.count()).toBe(2);
    expect(capabilities.countForServer("srv")).toBe(2);

    capabilities.replaceServerCapabilities("srv", [makeCapability("srv.c.get")]);
    expect(capabilities.count()).toBe(3);
    expect(capabilities.countForServer("srv")).toBe(1);
    const vanished = capabilities.get("srv.a.get");
    expect(vanished?.availability).toBe("unavailable");
    expect(capabilities.getByTool("srv", "srv_c_get")).toBeDefined();
  });

  it("round-trips metadata and schema summaries", () => {
    const original = makeCapability("srv.meta.get");
    original.metadata = { tags: ["x"], keywords: ["kw1", "kw2"], risk: "write" };
    original.inputSchemaSummary = { type: "object" };
    capabilities.replaceServerCapabilities("srv", [original]);
    const loaded = capabilities.get("srv.meta.get");
    expect(loaded?.metadata.risk).toBe("write");
    expect(loaded?.metadata.keywords).toEqual(["kw1", "kw2"]);
    expect(loaded?.inputSchemaSummary).toEqual({ type: "object" });
    expect(loaded?.availability).toBe("available");
  });

  it("updates availability in bulk", () => {
    capabilities.replaceServerCapabilities("srv", [makeCapability("srv.a.get"), makeCapability("srv.b.get")]);
    capabilities.setAvailability(["srv.a.get", "srv.b.get"], "unavailable");
    expect(capabilities.get("srv.a.get")?.availability).toBe("unavailable");
    expect(capabilities.get("srv.b.get")?.availability).toBe("unavailable");
  });

  it("removes by server without touching others", () => {
    new ServerRepository(db).ensureServer("other", "Other", "h2");
    capabilities.replaceServerCapabilities("srv", [makeCapability("srv.a.get")]);
    capabilities.replaceServerCapabilities("other", [makeCapability("other.a.get", "other")]);
    expect(capabilities.getByTool("other", "other_a_get")).toBeDefined();
    capabilities.removeServer("srv");
    expect(capabilities.get("srv.a.get")).toBeUndefined();
    expect(capabilities.get("other.a.get")).toBeDefined();
  });
});

describe("storage/analytics-repository", () => {
  let db: Database;
  let analytics: AnalyticsRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    db.migrate();
    const servers = new ServerRepository(db);
    servers.ensureServer("srv", "Srv", "h");
    new CapabilityRepository(db).replaceServerCapabilities("srv", [
      makeCapability("srv.first.get"),
      makeCapability("srv.second.list"),
    ]);
    analytics = new AnalyticsRepository(db);
  });
  afterEach(() => db.close());

  it("aggregates routing stats incrementally with running average latency", () => {
    analytics.bumpRouting("srv.first.get", { success: true, latencyMs: 100 }, 1000);
    analytics.bumpRouting("srv.first.get", { success: false, latencyMs: 300 }, 2000);
    const stats = analytics.getRoutingStats().get("srv.first.get");
    expect(stats?.usageCount).toBe(2);
    expect(stats?.successCount).toBe(1);
    expect(stats?.failureCount).toBe(1);
    expect(stats?.successRate).toBeCloseTo(0.5);
    expect(stats?.avgLatencyMs).toBeCloseTo(200);
    expect(stats?.lastUsedAt).toBe(2000);
  });

  it("records sequences and normalizes probabilities", () => {
    analytics.recordSequence("srv.first.get", "srv.second.list");
    analytics.recordSequence("srv.first.get", "srv.second.list");
    analytics.recordSequence("srv.first.get", "srv.first.get");
    const top = analytics.topNext("srv.first.get", 5);
    expect(top.find((entry) => entry.nextCapabilityId === "srv.second.list")?.probability).toBeCloseTo(2 / 3);
  });

  it("counts events by type and prunes old rows", () => {
    const now = Date.now();
    analytics.insertEvent({ type: "capability.searched", timestamp: now - 10 * 86_400_000 });
    analytics.insertEvent({ type: "capability.searched", timestamp: now });
    analytics.insertEvent({ type: "execution.succeeded", timestamp: now });
    expect(analytics.countsByType(0).get("capability.searched")).toBe(2);
    expect(analytics.pruneEvents(5)).toBeGreaterThanOrEqual(1);
    expect(analytics.countsByType(0).get("capability.searched")).toBe(1);
  });

  it("resets usage data only", () => {
    analytics.bumpRouting("srv.first.get", { success: true }, 1);
    analytics.recordSequence("srv.first.get", "srv.second.list");
    analytics.resetAnalytics();
    expect(analytics.getRoutingStats().size).toBe(0);
    expect(analytics.sequenceCount()).toBe(0);
  });
});
