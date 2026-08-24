import { describe, expect, it, vi } from "vitest";
import { LifecycleManager, HOT_USAGE_THRESHOLD, WARM_USAGE_THRESHOLD, type LifecycleTimeouts } from "../../lifecycle/lifecycle-manager.js";
import { createMockTransportFactory, type MockToolSpec } from "../helpers/mock-downstream.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPServerDefinition } from "../../models/types.js";
import { createLogger } from "../../utils/logger.js";

const TIMEOUTS: LifecycleTimeouts = {
  startupTimeoutMs: 5000,
  callTimeoutMs: 5000,
  indexTimeoutMs: 5000,
  hotIdleTimeoutMs: 900_000,
  warmIdleTimeoutMs: 300_000,
  coldIdleTimeoutMs: 60_000,
};

function definition(id: string): MCPServerDefinition {
  return {
    id,
    name: id,
    description: "",
    command: "mock",
    args: [],
    env: {},
    tags: [],
    enabled: true,
    alwaysOn: false,
    source: "project",
  };
}

function toolsFor(id: string): MockToolSpec[] {
  return [{ name: `${id}_echo`, description: `echo for ${id}` }];
}

describe("lifecycle/lifecycle-manager", () => {
  it("lazily starts servers only when needed (spec scenario C)", async () => {
    const { factory, startedServers } = createMockTransportFactory({
      alpha: toolsFor("alpha"),
      beta: toolsFor("beta"),
    });
    const catalog = { get: (id: string) => (id === "alpha" || id === "beta" ? definition(id) : undefined), ids: () => ["alpha", "beta"] };
    const manager = new LifecycleManager(catalog, factory, "0.0.0-test", TIMEOUTS, createLogger("test", { level: "silent" }));

    expect(manager.isRunning("alpha")).toBe(false);
    expect(manager.status("beta")).toBe("not_started");
    await manager.listTools("alpha");
    expect(startedServers()).toEqual(["alpha"]);
    expect(manager.isRunning("alpha")).toBe(true);
    expect(manager.status("beta")).toBe("not_started");
    await manager.dispose();
  });

  it("reuses a running connection across calls and dedupes concurrent starts", async () => {
    const { factory, startedServers } = createMockTransportFactory({ alpha: toolsFor("alpha") });
    const catalog = { get: (id: string) => (id === "alpha" ? definition(id) : undefined), ids: () => ["alpha"] };
    const events = { onStarted: vi.fn() };
    const manager = new LifecycleManager(catalog, factory, "0.0.0-test", TIMEOUTS, createLogger("test", { level: "silent" }), events);

    const [first, second] = await Promise.all([
      manager.ensureStarted("alpha"),
      manager.ensureStarted("alpha"),
    ]);
    expect(first).toBe(second);
    await manager.callTool("alpha", "alpha_echo", {});
    expect(events.onStarted).toHaveBeenCalledTimes(1);
    expect(startedServers()).toHaveLength(1);
    await manager.dispose();
    expect(manager.status("alpha")).toBe("not_started");
  });

  it("throws structured errors for missing and disabled servers", async () => {
    const { factory } = createMockTransportFactory({ alpha: toolsFor("alpha") });
    const disabled = { ...definition("off"), enabled: false };
    const catalog = {
      get: (id: string) => (id === "off" ? disabled : undefined),
      ids: () => ["off"],
    };
    const manager = new LifecycleManager(catalog, factory, "0.0.0-test", TIMEOUTS, createLogger("test", { level: "silent" }));
    await expect(manager.ensureStarted("ghost")).rejects.toMatchObject({ code: "MCP_NOT_FOUND" });
    await expect(manager.ensureStarted("off")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await manager.dispose();
  });

  it("starts only enabled always-on servers at boot", async () => {
    const { factory } = createMockTransportFactory({ on1: toolsFor("on1"), off1: toolsFor("off1") });
    const on = { ...definition("on1"), alwaysOn: true };
    const off = { ...definition("off1"), alwaysOn: true, enabled: false };
    const catalog = {
      get: (id: string) => (id === "on1" ? on : id === "off1" ? off : undefined),
      ids: () => ["on1", "off1"],
    };
    const manager = new LifecycleManager(catalog, factory, "0.0.0-test", TIMEOUTS, createLogger("test", { level: "silent" }));
    const started = await manager.startAlwaysOnServers();
    expect(started).toEqual(["on1"]);
    await manager.dispose();
  });

  it("stops idle servers according to tiered timeouts", async () => {
    const { factory } = createMockTransportFactory({ cold: toolsFor("cold"), warm: toolsFor("warm"), hot: toolsFor("hot") });
    const catalog = {
      get: (id: string) => (["cold", "warm", "hot"].includes(id) ? definition(id) : undefined),
      ids: () => ["cold", "warm", "hot"],
    };
    let tick = 0;
    const clock = (): number => tick;
    const stopped: string[] = [];
    const usageByServer = new Map<string, number>([
      ["cold", 0],
      ["warm", WARM_USAGE_THRESHOLD],
      ["hot", HOT_USAGE_THRESHOLD],
    ]);
    const manager = new LifecycleManager(
      catalog,
      factory,
      "0.0.0-test",
      { ...TIMEOUTS, coldIdleTimeoutMs: 10, warmIdleTimeoutMs: 20, hotIdleTimeoutMs: 30 },
      createLogger("test", { level: "silent" }),
      { onStopped: (id) => stopped.push(id) },
      (serverId) => usageByServer.get(serverId) ?? 0,
      clock,
    );
    await manager.ensureStarted("cold");
    await manager.ensureStarted("warm");
    await manager.ensureStarted("hot");

    tick = 15;
    await (manager as unknown as { sweepIdle(): Promise<void> }).sweepIdle();
    expect(stopped).toContain("cold");
    expect(stopped).not.toContain("warm");

    tick = 25;
    await (manager as unknown as { sweepIdle(): Promise<void> }).sweepIdle();
    expect(stopped).toContain("warm");
    expect(stopped).not.toContain("hot");

    tick = 40;
    await (manager as unknown as { sweepIdle(): Promise<void> }).sweepIdle();
    expect(stopped).toContain("hot");
    await manager.dispose();
  });

  it("exposes usage tier thresholds in the documented order", () => {
    expect(HOT_USAGE_THRESHOLD).toBeGreaterThan(WARM_USAGE_THRESHOLD);
    expect(WARM_USAGE_THRESHOLD).toBeGreaterThan(0);
  });

  it("surfaces startup failures as MCP_START_FAILED with no secrets", async () => {
    const failingFactory = {
      create: () => {
        throw new Error("spawn node ENOENT with SECRET_VALUE");
      },
    };
    const catalog = { get: (id: string) => (id === "broken" ? definition("broken") : undefined), ids: () => ["broken"] };
    const failures: string[] = [];
    const manager = new LifecycleManager(
      catalog,
      failingFactory,
      "0.0.0-test",
      TIMEOUTS,
      createLogger("test", { level: "silent" }),
      { onStartFailed: (_id, error) => failures.push(error.code) },
    );
    await expect(manager.ensureStarted("broken")).rejects.toMatchObject({
      code: "MCP_START_FAILED",
    });
    expect(failures).toEqual(["MCP_START_FAILED"]);
    await manager.dispose();
  });
});

describe("lifecycle/quarantine", () => {
  const QUARANTINE = { failureThreshold: 3, backoffMs: 1000, maxBackoffMs: 4000 };

  function brokenFactory(failUntil: { calls: number }): { create: () => never; attempts: () => number } {
    let attempts = 0;
    return {
      create: (): never => {
        attempts++;
        failUntil.calls = attempts;
        throw new Error("spawn broken ENOENT");
      },
      attempts: () => attempts,
    };
  }

  function managerFor(
    factory: { create: (definition: MCPServerDefinition) => never },
    clock: () => number,
    events = {},
    quarantine = QUARANTINE,
  ): LifecycleManager {
    const catalog = {
      get: (id: string) => (id === "broken" ? definition("broken") : undefined),
      ids: () => ["broken"],
    };
    return new LifecycleManager(
      catalog,
      factory as never,
      "0.0.0-test",
      TIMEOUTS,
      createLogger("test", { level: "silent" }),
      events,
      () => 0,
      clock,
      quarantine,
    );
  }

  it("arms quarantine when a server starts but hangs the initialize handshake", async () => {
    let attempts = 0;
    const hangingFactory = {
      create: (): Transport => {
        attempts++;
        return {
          start: async (): Promise<void> => undefined,
          send: async (): Promise<void> => undefined,
          close: async (): Promise<void> => undefined,
        } as unknown as Transport;
      },
    };
    const catalog = {
      get: (id: string) => (id === "broken" ? definition("broken") : undefined),
      ids: () => ["broken"],
    };
    const manager = new LifecycleManager(
      catalog,
      hangingFactory as never,
      "0.0.0-test",
      { ...TIMEOUTS, startupTimeoutMs: 50 },
      createLogger("test", { level: "silent" }),
      {},
      () => 0,
      () => 0,
      QUARANTINE,
    );

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(manager.ensureStarted("broken")).rejects.toMatchObject({ code: "TIMEOUT" });
    }
    expect(attempts).toBe(3);
    expect(manager.isQuarantined("broken")).toBe(true);
    expect(manager.health("broken")).toMatchObject({ consecutiveFailures: 3, lastFailureCode: "TIMEOUT" });
    await expect(manager.ensureStarted("broken")).rejects.toMatchObject({ code: "MCP_QUARANTINED" });
    expect(attempts).toBe(3);
    await manager.dispose();
  }, 5000);

  it("quarantines a server after the configured consecutive failures and then fails fast", async () => {
    const tick = 0;
    const factory = brokenFactory({ calls: 0 });
    const manager = managerFor(factory, () => tick);

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(manager.ensureStarted("broken")).rejects.toMatchObject({ code: "MCP_START_FAILED" });
    }
    expect(factory.attempts()).toBe(3);
    expect(manager.isQuarantined("broken")).toBe(true);
    expect(manager.health("broken")).toMatchObject({
      consecutiveFailures: 3,
      quarantined: true,
      score: 0,
      lastFailureCode: "MCP_START_FAILED",
    });

    await expect(manager.ensureStarted("broken")).rejects.toMatchObject({ code: "MCP_QUARANTINED" });
    expect(factory.attempts()).toBe(3);
    await manager.dispose();
  });

  it("backs off exponentially up to the cap and retries once the window expires", async () => {
    let tick = 0;
    const factory = brokenFactory({ calls: 0 });
    const manager = managerFor(factory, () => tick);

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(manager.ensureStarted("broken")).rejects.toBeDefined();
    }
    expect(manager.health("broken").quarantinedUntil).toBe(1000);

    tick = 1000;
    expect(manager.isQuarantined("broken")).toBe(false);
    await expect(manager.ensureStarted("broken")).rejects.toMatchObject({ code: "MCP_START_FAILED" });
    expect(factory.attempts()).toBe(4);
    expect(manager.health("broken").quarantinedUntil).toBe(1000 + 2000);

    tick = 3000;
    await expect(manager.ensureStarted("broken")).rejects.toMatchObject({ code: "MCP_START_FAILED" });
    expect(manager.health("broken").quarantinedUntil).toBe(3000 + 4000);

    tick = 7000;
    await expect(manager.ensureStarted("broken")).rejects.toMatchObject({ code: "MCP_START_FAILED" });
    expect(manager.health("broken").quarantinedUntil).toBe(7000 + 4000);
    await manager.dispose();
  });

  it("clears failures and quarantine as soon as a start succeeds", async () => {
    let tick = 0;
    let failing = true;
    const { factory: workingFactory } = createMockTransportFactory({ broken: toolsFor("broken") });
    const factory = {
      create: (def: MCPServerDefinition) => {
        if (failing) throw new Error("spawn broken ENOENT");
        return workingFactory.create(def);
      },
    };
    const changes: Array<{ failures: number; quarantined: boolean }> = [];
    const manager = managerFor(factory as never, () => tick, {
      onHealthChanged: (_id: string, health: { consecutiveFailures: number; quarantined: boolean }) =>
        changes.push({ failures: health.consecutiveFailures, quarantined: health.quarantined }),
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(manager.ensureStarted("broken")).rejects.toBeDefined();
    }
    expect(changes.map((entry) => entry.failures)).toEqual([1, 2, 3]);
    expect(changes.at(-1)?.quarantined).toBe(true);

    tick = 1000;
    failing = false;
    await manager.ensureStarted("broken");
    expect(manager.health("broken")).toMatchObject({ consecutiveFailures: 0, quarantined: false, score: 1 });
    expect(changes.at(-1)).toEqual({ failures: 0, quarantined: false });
    await manager.dispose();
  });

  it("never quarantines when the threshold is zero", async () => {
    const factory = brokenFactory({ calls: 0 });
    const manager = managerFor(factory, () => 0, {}, { ...QUARANTINE, failureThreshold: 0 });
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(manager.ensureStarted("broken")).rejects.toMatchObject({ code: "MCP_START_FAILED" });
    }
    expect(factory.attempts()).toBe(5);
    expect(manager.isQuarantined("broken")).toBe(false);
    expect(manager.health("broken")).toMatchObject({ consecutiveFailures: 5, score: 0 });
    await manager.dispose();
  });

  it("counts an unexpected disconnect as a lifecycle failure", async () => {
    const { factory } = createMockTransportFactory({ alpha: toolsFor("alpha") });
    const catalog = { get: (id: string) => (id === "alpha" ? definition(id) : undefined), ids: () => ["alpha"] };
    const manager = new LifecycleManager(catalog, factory, "0.0.0-test", TIMEOUTS, createLogger("test", { level: "silent" }));
    await manager.ensureStarted("alpha");
    (manager as unknown as { handleUnexpectedDisconnect(id: string): void }).handleUnexpectedDisconnect("alpha");
    expect(manager.health("alpha")).toMatchObject({
      consecutiveFailures: 1,
      lastFailureCode: "MCP_CONNECTION_FAILED",
    });
    expect(manager.isRunning("alpha")).toBe(false);
    await manager.dispose();
  });

  it("restores persisted health so quarantine survives a restart", async () => {
    const tick = 5000;
    const factory = brokenFactory({ calls: 0 });
    const manager = managerFor(factory, () => tick);
    manager.restoreHealth("broken", {
      consecutiveFailures: 4,
      quarantinedUntil: 9000,
      lastFailureAt: 4000,
      lastFailureCode: "MCP_START_FAILED",
    });
    await expect(manager.ensureStarted("broken")).rejects.toMatchObject({ code: "MCP_QUARANTINED" });
    expect(factory.attempts()).toBe(0);
    expect(manager.quarantineRetryMs("broken")).toBe(4000);
    expect(manager.healthAll().map((entry) => entry.serverId)).toEqual(["broken"]);
    await manager.dispose();
  });
});
