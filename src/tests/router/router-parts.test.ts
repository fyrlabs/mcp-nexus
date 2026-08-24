import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, Ranker, neutralUsageSignals, type UsageSignals } from "../../router/ranker.js";
import { PolicyEngine } from "../../router/policies.js";
import type { CapabilityMatch } from "../../models/types.js";
import type { RoutingConfig } from "../../config/schema.js";

function makeMatch(id: string, serverId: string, signals: Partial<CapabilityMatch["signals"]> = {}): CapabilityMatch {
  return {
    capabilityId: id,
    serverId,
    toolName: id.split(".").pop() ?? id,
    title: id,
    description: "",
    score: 0,
    signals: {
      exact: 0,
      lexical: 0,
      semantic: 0,
      userAffinity: 0,
      recentUsage: 0,
      globalUsage: 0,
      successRate: 0,
      sequence: 0,
      pin: 0,
      ...signals,
    },
    reason: "base",
    risk: "read",
    flags: [],
  };
}

function usage(overrides: Partial<UsageSignals> = {}): UsageSignals {
  return { ...neutralUsageSignals(), ...overrides };
}

describe("router/ranker", () => {
  const now = Date.now();

  it("produces deterministic weighted scores with explanations", () => {
    const ranker = new Ranker();
    const ranked = ranker.rank(
      makeMatch("github.prs.list", "github", { lexical: 1 }),
      usage({ usageCount: 10, lastUsedAt: now, successRate: 1, globalShare: 1, sequenceProbability: 1 }),
      { now },
    );
    expect(ranked.score).toBeGreaterThan(0);
    expect(ranked.score).toBeLessThanOrEqual(1);
    expect(ranked.reason).toContain("lexical=1");
  });

  it("boosts frequently used capabilities for the same query", () => {
    const ranker = new Ranker();
    const cold = ranker.rank(makeMatch("a.x.get", "a", { lexical: 0.5 }), usage(), { now });
    const hot = ranker.rank(
      makeMatch("b.x.get", "b", { lexical: 0.5 }),
      usage({ usageCount: 30, lastUsedAt: now, successRate: 1, globalShare: 1 }),
      { now },
    );
    expect(hot.score).toBeGreaterThan(cold.score);
  });

  it("pins outrank learned popularity (spec scenario G)", () => {
    const ranker = new Ranker();
    const popularUnpinned = ranker.rank(
      makeMatch("popular.tool", "srv", { lexical: 1 }),
      usage({ usageCount: 100, lastUsedAt: now, successRate: 1, globalShare: 1 }),
      { now },
    );
    const pinnedRare = ranker.rank(
      makeMatch("rare.tool", "srv", { pin: 1, lexical: 0.05 }),
      usage(),
      { now },
    );
    expect(pinnedRare.score).toBeGreaterThanOrEqual(0.97);
    expect(pinnedRare.score).toBeGreaterThan(popularUnpinned.score);
  });

  it("decays recency within a day window", () => {
    const ranker = new Ranker();
    const fresh = ranker.rank(makeMatch("a.b.get", "a"), usage({ lastUsedAt: now }), { now });
    const stale = ranker.rank(
      makeMatch("a.c.get", "a"),
      usage({ lastUsedAt: now - 3 * 60 * 60 * 1000 }),
      { now },
    );
    expect(fresh.signals.recentUsage).toBeGreaterThan(stale.signals.recentUsage);
    expect(stale.signals.userAffinity).toBe(fresh.signals.userAffinity ? fresh.signals.userAffinity : 0);
  });

  it("honors configured weight overrides", () => {
    const ranker = new Ranker({ lexical: 1, semantic: 0 });
    expect(ranker.activeWeights.lexical).toBe(1);
    expect(ranker.activeWeights.semantic).toBe(0);
    expect(DEFAULT_WEIGHTS.lexical).toBeGreaterThan(0);
  });
});

describe("router/policies", () => {
  function engine(overrides: Partial<RoutingConfig>): PolicyEngine {
    return new PolicyEngine({
      aliases: {},
      limit: 8,
      minScore: 0,
      pinnedServers: [],
      pinnedCapabilities: [],
      strategy: "adaptive",
      prefetch: true,
      semanticSearch: false,
      weights: {},
      disabledServers: [],
      disabledCapabilities: [],
      ...overrides,
    } as RoutingConfig);
  }

  it("blocks disabled capabilities and servers outright", () => {
    const policies = engine({
      disabledCapabilities: ["github.repo.delete"],
      disabledServers: ["aws"],
    });
    expect(policies.evaluate("github.repo.delete", "github").allowed).toBe(false);
    expect(policies.evaluate("anything.else", "aws").allowed).toBe(false);
    expect(policies.evaluate("github.prs.list", "github").allowed).toBe(true);
  });

  it("filters match lists into allowed and blocked buckets", () => {
    const policies = engine({ disabledCapabilities: ["x.blocked"] });
    const matches = [makeMatch("x.ok", "x"), makeMatch("x.blocked", "x")];
    const { allowed, blocked } = policies.filterMatches(matches, () => true);
    expect(allowed.map((match) => match.capabilityId)).toEqual(["x.ok"]);
    expect(blocked).toHaveLength(1);
  });

  it("reports pin status", () => {
    const policies = engine({ pinnedCapabilities: ["a.pin.get"], pinnedServers: ["srv"] });
    expect(policies.isPinned("a.pin.get")).toBe(true);
    expect(policies.isServerPinned("srv")).toBe(true);
    expect(policies.isPinned("other.tool")).toBe(false);
  });
});
