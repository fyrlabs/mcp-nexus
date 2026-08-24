import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { HashingEmbeddingProvider, OpenAICompatibleProvider, createEmbeddingProvider } from "../../index/embedding-providers.js";
import { SemanticIndex, cosineSimilarity } from "../../index/semantic.js";
import { CapabilityIndex } from "../../index/capability-index.js";
import { EmbeddingCacheRepository } from "../../storage/embedding-cache-repository.js";
import { Database } from "../../storage/database.js";
import { CapabilityRepository } from "../../storage/capability-repository.js";
import { ServerRepository } from "../../storage/server-repository.js";
import { validateConfig } from "../../config/loader.js";
import type { Capability } from "../../models/types.js";
import { createLogger } from "../../utils/logger.js";

const SILENT = createLogger("test", { level: "silent" });

function cacheAdapter(repo: EmbeddingCacheRepository, provider: { name: string; model?: string }) {
  return {
    loadAll: () => repo.loadAll(provider.name, provider.model ?? ""),
    store: (entries: Map<string, { vector: Float32Array; contentHash: string }>) =>
      repo.store(
        new Map(
          [...entries].map(([id, entry]) => [
            id,
            {
              provider: provider.name,
              model: provider.model ?? "",
              contentHash: entry.contentHash,
              vector: entry.vector,
            },
          ]),
        ),
      ),
  };
}

describe("index/embedding-providers: hashing", () => {
  const provider = new HashingEmbeddingProvider(256);

  it("produces deterministic, normalized vectors of the configured size", async () => {
    const first = await provider.embed("list pull requests in my repository");
    const second = await provider.embed("list pull requests in my repository");
    expect(first).toEqual(second);
    expect(first?.length).toBe(256);
    const norm = Math.sqrt((first ?? []).reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("scores token-overlapping texts above unrelated ones", async () => {
    const base = await provider.embed("find review comments on a pull request");
    const related = await provider.embed("list review comments for a pull request");
    const unrelated = await provider.embed("deploy the production pipeline now");
    expect(cosineSimilarity(base ?? [], related ?? [])).toBeGreaterThan(
      cosineSimilarity(base ?? [], unrelated ?? []),
    );
  });

  it("embeds batches in one call with stable ordering", async () => {
    const vectors = await provider.embedBatch(["alpha beta", "gamma", "alpha beta"]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(vectors[2]);
    expect(vectors[1]?.some((value) => value !== 0)).toBe(true);
  });

  it("is the provider created for routing.semantic.provider=hash", () => {
    const created = createEmbeddingProvider({ provider: "hash", model: "", batchSize: 64, timeoutMs: 20000 });
    expect(created.name).toBe("hash");
    expect(created.active).toBe(true);
    expect(createEmbeddingProvider({ provider: "null", model: "", batchSize: 64, timeoutMs: 20000 }).active).toBe(false);
  });
});

function mockFetchResponder(): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
    return new Response(
      JSON.stringify({
        data: body.input.map((text, index) => ({ index, embedding: [text.length, index + 1, 3] })),
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("index/embedding-providers: openai-compatible", () => {
  it("posts batches to the configured endpoint with auth and parses index-ordered embeddings", async () => {
    const { fetchImpl, calls } = mockFetchResponder();
    const provider = new OpenAICompatibleProvider({
      model: "nomic-embed-text",
      baseUrl: "http://localhost:11434/v1/",
      apiKey: "sk-test",
      fetchImpl,
    });
    expect(provider.dimensions).toBe(0);

    const vectors = await provider.embedBatch(["alpha", "beta"]);
    expect(vectors[0]).toEqual([5, 1, 3]);
    expect(vectors[1]).toEqual([4, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/embeddings");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(calls[0]?.init.body)) as { model: string; input: string[] };
    expect(body.model).toBe("nomic-embed-text");
    expect(body.input).toEqual(["alpha", "beta"]);
  });

  it("chunks large batches by batchSize", async () => {
    const { fetchImpl, calls } = mockFetchResponder();
    const provider = new OpenAICompatibleProvider({
      model: "m",
      batchSize: 2,
      fetchImpl,
    });
    const texts = ["a", "b", "c", "d", "e"];
    const vectors = await provider.embedBatch(texts);
    expect(vectors).toHaveLength(5);
    expect(calls).toHaveLength(3);
  });

  it("throws on http errors and dimension mismatches so callers can fall back", async () => {
    const failing: typeof fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({ model: "m", fetchImpl: failing });
    await expect(provider.embed("text")).rejects.toThrow(/HTTP 429/);

    const mismatch: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
      return new Response(
        JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 2] })) }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const strict = new OpenAICompatibleProvider({ model: "m", dimensions: 3, fetchImpl: mismatch });
    await expect(strict.embed("text")).rejects.toThrow(/dimensions mismatch/);
  });

  it("requires a model name", () => {
    expect(() => new OpenAICompatibleProvider({ model: " " })).toThrow(/model name/);
  });
});

describe("index/semantic: persistent cache", () => {
  let db: Database;
  let cache: EmbeddingCacheRepository;
  let providerCalls: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.migrate();
    const servers = new ServerRepository(db);
    servers.ensureServer("a", "A", "hash");
    new CapabilityRepository(db).replaceServerCapabilities("a", [
      capabilityRow("a.b.get"),
      capabilityRow("a.c.list"),
    ]);
    cache = new EmbeddingCacheRepository(db);
    providerCalls = 0;
  });

  afterEach(() => db.close());

  function capabilityRow(id: string): Capability {
    return {
      capabilityId: id,
      serverId: "a",
      toolName: id.replace(/\./g, "_"),
      title: id,
      description: id,
      inputSchemaSummary: {},
      metadata: { tags: [], keywords: [], risk: "read" },
      availability: "available",
      updatedAt: Date.now(),
    };
  }

  function countingHashProvider(): HashingEmbeddingProvider {
    const inner = new HashingEmbeddingProvider(64);
    return {
      name: "hash",
      model: "",
      dimensions: 64,
      active: true,
      embed: async (text: string) => {
        providerCalls++;
        return inner.embed(text);
      },
      embedBatch: async (texts: string[]) => {
        providerCalls += texts.length;
        return inner.embedBatch(texts);
      },
    } as HashingEmbeddingProvider;
  }

  it("persists embeddings so a fresh index hydrates without provider calls", async () => {
    const provider = countingHashProvider();
    const first = new SemanticIndex(provider, cacheAdapter(cache, provider));
    await first.indexTexts([
      { id: "a.b.get", text: "get a b thing" },
      { id: "a.c.list", text: "list c things" },
    ]);
    expect(first.size).toBe(2);
    expect(cache.count()).toBe(2);
    const callsAfterIndex = providerCalls;

    const secondProvider = countingHashProvider();
    const second = new SemanticIndex(secondProvider, cacheAdapter(cache, secondProvider));
    await second.hydrateFromCache();
    expect(second.size).toBe(2);
    expect(second.has("a.b.get")).toBe(true);
    expect(providerCalls).toBe(callsAfterIndex);

    const hits = await second.search("get a b thing", 5);
    expect(hits[0]?.id).toBe("a.b.get");
    expect(providerCalls).toBe(callsAfterIndex + 1);
  });

  it("returns no hits when the provider fails at query time (lexical fallback path)", async () => {
    const failing = new SemanticIndex({
      name: "openai:x",
      model: "x",
      dimensions: 3,
      active: true,
      embed: async () => {
        throw new Error("down");
      },
    }, cacheAdapter(cache, { name: "openai:x", model: "x" }));
    failing.setVector("a.b.get", [1, 0, 0]);
    await expect(failing.search("query", 5)).resolves.toEqual([]);
  });
});

describe("index/capability-index with semantic provider and cache", () => {
  let db: Database;
  let servers: ServerRepository;
  let capabilities: CapabilityRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.migrate();
    servers = new ServerRepository(db);
    servers.ensureServer("srv", "Srv", "hash");
    capabilities = new CapabilityRepository(db);
  });

  afterEach(() => db.close());

  function makeIndex(cacheRepo: EmbeddingCacheRepository | undefined, provider = new HashingEmbeddingProvider(64)): CapabilityIndex {
    const adapter = cacheRepo ? cacheAdapter(cacheRepo, provider) : undefined;
    return new CapabilityIndex(
      { listTools: async () => { throw new Error("not used in this test"); } } as never,
      capabilities,
      servers,
      { allDefinitions: () => [{ id: "srv", command: "node", args: [], env: {}, tags: [], enabled: true, alwaysOn: false, source: "project" as const }] },
      validateConfig({ version: 1 }).routing,
      SILENT,
      {},
      provider,
      Date.now,
      adapter,
    );
  }

  function capability(id: string): Capability {
    return {
      capabilityId: id,
      serverId: "srv",
      toolName: id.replace(/\./g, "_"),
      title: id.split(".").slice(1).join(" "),
      description: `${id} does review comment things`,
      inputSchemaSummary: {},
      metadata: { tags: [], keywords: [], risk: "read" },
      availability: "available",
      updatedAt: Date.now(),
    };
  }

  it("embeds on index and hydrates from cache on a cold start without re-embedding", async () => {
    const cacheRepo = new EmbeddingCacheRepository(db);
    const first = makeIndex(cacheRepo);
    capabilities.replaceServerCapabilities("srv", [capability("srv.review.comments.list"), capability("srv.echo")]);
    await first["reloadFromStore"]();
    expect(cacheRepo.count()).toBe(2);

    const second = makeIndex(cacheRepo);
    await second.hydrate();
    expect(second.semanticEnabled).toBe(true);
    const hits = await second.search("review comments");
    expect(hits[0]?.capabilityId).toBe("srv.review.comments.list");
    expect(hits[0]?.signals.semantic).toBeGreaterThan(0);
    expect(cacheRepo.count()).toBe(2);
  });

  it("replacing capabilities keeps embeddings for unchanged tools", async () => {
    const cacheRepo = new EmbeddingCacheRepository(db);
    const index = makeIndex(cacheRepo);
    capabilities.replaceServerCapabilities("srv", [capability("srv.a.get"), capability("srv.b.list")]);
    await index["reloadFromStore"]();
    expect(cacheRepo.count()).toBe(2);

    capabilities.replaceServerCapabilities("srv", [capability("srv.a.get"), capability("srv.c.list")]);
    await index["reloadFromStore"]();
    expect(cacheRepo.count()).toBe(3);
    const cached = cacheRepo.loadAll("hash", "");
    expect(cached.has("srv.a.get")).toBe(true);
    expect(cached.has("srv.c.list")).toBe(true);
  });

  it("degrades silently when the provider fails during indexing", async () => {
    const failing = {
      name: "openai:down",
      model: "down",
      dimensions: 0,
      active: true,
      embed: async () => {
        throw new Error("provider down");
      },
    };
    const index = makeIndex(new EmbeddingCacheRepository(db), failing as never);
    capabilities.replaceServerCapabilities("srv", [capability("srv.a.get")]);
    await expect(index["reloadFromStore"]()).resolves.toBeUndefined();
    const hits = await index.search("a get");
    expect(hits[0]?.capabilityId).toBe("srv.a.get");
    expect(hits[0]?.signals.semantic).toBe(0);
  });
});

describe("config: semantic block", () => {
  it("defaults to the null provider and validates the openai variant", () => {
    const defaults = validateConfig({});
    expect(defaults.routing.semantic.provider).toBe("null");
    expect(defaults.routing.semantic.model).toBe("text-embedding-3-small");
    expect(defaults.routing.semantic.batchSize).toBe(64);

    const configured = validateConfig({
      version: 1,
      routing: {
        semanticSearch: true,
        semantic: { provider: "openai", baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text" },
      },
    });
    expect(configured.routing.semantic.provider).toBe("openai");
    expect(configured.routing.semantic.baseUrl).toBe("http://localhost:11434/v1");

    expect(() =>
      validateConfig({ version: 1, routing: { semantic: { provider: "openai", baseUrl: "not a url" } } }),
    ).toThrow();
  });
});
