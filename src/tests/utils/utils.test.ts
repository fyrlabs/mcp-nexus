import { describe, expect, it } from "vitest";
import { contentHash, stableStringify } from "../../utils/hash.js";
import { redactEnv, redactUnknown, truncate } from "../../utils/redact.js";
import { Deferred, sleep, withTimeout } from "../../utils/async.js";
import { createLogger } from "../../utils/logger.js";
import { packageVersion } from "../../utils/version.js";

describe("utils/hash", () => {
  it("produces stable output regardless of key order", () => {
    expect(stableStringify({ a: 1, b: [1, 2] })).toBe(stableStringify({ b: [1, 2], a: 1 }));
    expect(contentHash({ a: 1 })).toBe(contentHash({ a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe("utils/redact", () => {
  it("redacts secret-looking keys recursively", () => {
    const result = redactUnknown({
      GITHUB_TOKEN: "abc",
      nested: { apiKey: "xyz", plain: "visible" },
      list: [{ password: "pw" }],
    }) as Record<string, unknown>;
    expect(result.GITHUB_TOKEN).toBe("[redacted]");
    const nested = result.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe("[redacted]");
    expect(nested.plain).toBe("visible");
  });

  it("redacts env maps and truncates long strings", () => {
    expect(redactEnv({ JIRA_TOKEN: "s", HOME: "/home" })).toEqual({ JIRA_TOKEN: "[redacted]", HOME: "/home" });
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("ab", 4)).toBe("ab");
  });
});

describe("utils/async", () => {
  it("resolves deferreds once", async () => {
    const deferred = new Deferred<number>();
    const promise = deferred.promise;
    deferred.resolve(7);
    deferred.resolve(9);
    await expect(promise).resolves.toBe(7);
    expect(deferred.isSettled).toBe(true);
  });

  it("times out slow promises with a NexusError", async () => {
    await expect(withTimeout(sleep(50), 5, "op")).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(withTimeout(Promise.resolve("fast"), 1000, "op")).resolves.toBe("fast");
  });
});

describe("utils/logger", () => {
  it("writes structured json lines to the given stream honoring levels", () => {
    const lines: string[] = [];
    const stream = { write: (chunk: string) => lines.push(chunk) } as unknown as NodeJS.WritableStream;
    const logger = createLogger("test", { level: "info", stream });
    logger.debug("hidden");
    logger.info("visible", { a: 1 });
    logger.child("sub").warn("child");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first.scope).toBe("test");
    expect(first.level).toBe("info");
    const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    expect(second.scope).toBe("test:sub");
  });

  it("exposes the workspace package version", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
