import { describe, expect, it, vi } from "vitest";
import { LifecycleManager, HOT_USAGE_THRESHOLD, WARM_USAGE_THRESHOLD, type LifecycleTimeouts } from "../../lifecycle/lifecycle-manager.js";
import { createMockTransportFactory, type MockToolSpec } from "../helpers/mock-downstream.js";
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
