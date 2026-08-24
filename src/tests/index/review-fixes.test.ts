import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { HashingEmbeddingProvider } from "../../index/embedding-providers.js";
import { SemanticIndex } from "../../index/semantic.js";
import { CapabilityIndex } from "../../index/capability-index.js";
import { EmbeddingCacheRepository } from "../../storage/embedding-cache-repository.js";
import { Database } from "../../storage/database.js";
import { CapabilityRepository } from "../../storage/capability-repository.js";
import { ServerRepository } from "../../storage/server-repository.js";
import { validateConfig } from "../../config/loader.js";
import type { Capability } from "../../models/types.js";
import { createLogger } from "../../utils/logger.js";

const SILENT = createLogger("test", { level: "silent" });

describe("review fixes: embedding cache invalidation (H3)", () => {
  let db: Database;
  let servers: ServerRepository;
  let capabilities: CapabilityRepository;
  let cache: EmbeddingCacheRepository;
  let embedCalls: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.migrate();
    servers = new ServerRepository(db);
    servers.ensureServer("srv", "Srv", "");
    capabilities = new CapabilityRepository(db);
    cache = new EmbeddingCacheRepository(db);
    embedCalls = 0;
  });

  afterEach(() => db.close());

  function makeIndex(): CapabilityIndex {
    const provider = new HashingEmbeddingProvider(64);
    const counting: typeof provider = {
      name: "hash",
      model: "",
      dimensions: 64,
      active: true,
      embed: async (text: string) => {
        embedCalls++;
        return provider.embed(text);
      },
      embedBatch: async (texts: string[]) => {
        embedCalls += texts.length;
        return provider.embedBatch(texts);
      },
    } as typeof provider;
    const adapter = {
      loadAll: () => cache.loadAll(counting.name, counting.model ?? ""),
      store: (entries: Map<string, { vector: Float32Array; contentHash: string }>) =>
        cache.store(
          new Map(
            [...entries].map(([id, entry]) => [
              id,
              { provider: counting.name, model: counting.model ?? "", contentHash: entry.contentHash, vector: entry.vector },
            ]),
          ),
        ),
    };
    return new CapabilityIndex(
      { listTools: async () => [] } as never,
      capabilities,
      servers,
      { allDefinitions: () => [] },
      validateConfig({ version: 1 }).routing,
      SILENT,
      {},
      counting,
      Date.now,
      adapter,
    );
  }

  function capability(id: string, description: string): Capability {
    return {
      capabilityId: id,
      serverId: "srv",
      toolName: id.replace(/\./g, "_"),
      title: id,
      description,
      inputSchemaSummary: {},
      metadata: { tags: [], keywords: [], risk: "read" },
      availability: "available",
      updatedAt: Date.now(),
    };
  }

  it("re-embeds when a tool description changes and skips unchanged tools", async () => {
    const index = makeIndex();
    capabilities.replaceServerCapabilities("srv", [
      capability("srv.a.get", "original description alpha"),
      capability("srv.b.list", "stable description beta"),
    ]);
    await index["reloadFromStore"]();
    expect(embedCalls).toBe(2);

    await index["reloadFromStore"]();
    expect(embedCalls).toBe(2);

    capabilities.replaceServerCapabilities("srv", [
      capability("srv.a.get", "CHANGED description alpha"),
      capability("srv.b.list", "stable description beta"),
    ]);
    await index["reloadFromStore"]();
    expect(embedCalls).toBe(3);
    expect(cache.count()).toBe(2);
  });

  it("warns once when the circuit opens and stops calling the provider", async () => {
    const warnings: string[] = [];
    let now = 1_000_000;
    const failingProvider = {
      name: "openai:down",
      model: "down",
      dimensions: 3,
      active: true,
      embed: async () => {
        embedCalls++;
        throw new Error("down");
      },
    };
    const semantic = new SemanticIndex(failingProvider as never, undefined, {
      cooldownMs: 1_000,
      failureThreshold: 2,
      now: () => now,
      onCircuitOpen: () => warnings.push("open"),
    });
    semantic.setVector("a.b.get", [1, 0, 0]);

    await semantic.search("q", 5);
    expect(embedCalls).toBe(1);
    await semantic.search("q", 5);
    expect(embedCalls).toBe(2);
    expect(semantic.circuitOpen).toBe(true);
    expect(warnings).toEqual(["open"]);

    await semantic.search("q", 5);
    await semantic.search("q", 5);
    expect(embedCalls).toBe(2);

    now += 1_500;
    expect(semantic.circuitOpen).toBe(false);
    await semantic.search("q", 5);
    expect(embedCalls).toBe(3);
  });
});

describe("review fixes: prefetch (M9)", () => {
  it("prewarms the predicted capability's server connection without executing", async () => {
    const { Router } = await import("../../router/router.js");
    const { PolicyEngine } = await import("../../router/policies.js");
    const { Ranker } = await import("../../router/ranker.js");
    const { Predictor } = await import("../../router/predictor.js");
    const { AnalyticsEngine } = await import("../../analytics/analytics-engine.js");
    const { Database } = await import("../../storage/database.js");
    const { CapabilityRepository } = await import("../../storage/capability-repository.js");
    const { ServerRepository } = await import("../../storage/server-repository.js");
    const { AnalyticsRepository } = await import("../../storage/analytics-repository.js");

    const db = new Database(":memory:");
    db.migrate();
    const servers = new ServerRepository(db);
    servers.ensureServer("srv", "Srv", "");
    const capabilities = new CapabilityRepository(db);
    capabilities.replaceServerCapabilities("srv", [
      {
        capabilityId: "srv.first.get",
        serverId: "srv",
        toolName: "first_get",
        title: "First",
        description: "",
        inputSchemaSummary: {},
        metadata: { tags: [], keywords: [], risk: "read" },
        availability: "available",
        updatedAt: 1,
      },
      {
        capabilityId: "srv.second.list",
        serverId: "srv",
        toolName: "second_list",
        title: "Second",
        description: "",
        inputSchemaSummary: {},
        metadata: { tags: [], keywords: [], risk: "read" },
        availability: "available",
        updatedAt: 1,
      },
    ]);
    const analyticsRepo = new AnalyticsRepository(db);
    analyticsRepo.recordSequence("srv.first.get", "srv.second.list");
    analyticsRepo.recordSequence("srv.first.get", "srv.second.list");

    const ensureStarted = vi.fn(async () => ({}) as never);
    const router = new Router(
      {
        markAvailable: () => undefined,
        markUnavailable: () => undefined,
        serverIdOf: (id: string) => (id.startsWith("srv.") ? "srv" : null),
        get: (id: string) =>
          ({
            capabilityId: id,
            serverId: "srv",
            toolName: id,
            title: id,
            description: "",
            inputSchemaSummary: {},
            metadata: { tags: [], keywords: [], risk: "read" },
            availability: "available",
            updatedAt: 1,
          }) as never,
        ensureIndexed: async () => [],
      } as never,
      {
        ensureStarted,
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      } as never,
      new PolicyEngine(validateConfig({ version: 1 }).routing),
      new Ranker(),
      new Predictor(new AnalyticsEngine(analyticsRepo, capabilities, { enabled: true, retentionDays: 90 })),
      new AnalyticsEngine(analyticsRepo, capabilities, { enabled: true, retentionDays: 90 }),
      validateConfig({ version: 1, routing: { prefetch: true } }).routing,
      SILENT,
    );

    await router.execute("srv.first.get", {}, { sessionId: "p" });
    await vi.waitFor(() => {
      expect(ensureStarted).toHaveBeenCalledWith("srv");
    });
    db.close();
  });
});
