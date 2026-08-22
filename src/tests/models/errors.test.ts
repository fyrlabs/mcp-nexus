import { describe, expect, it } from "vitest";
import { NexusError, capabilityAmbiguous, capabilityNotFound, isNexusError, mcpNotFound, toNexusError } from "../../models/errors.js";

describe("models/errors", () => {
  it("creates typed errors with codes and details", () => {
    const error = new NexusError("MCP_NOT_FOUND", "missing", { details: { serverId: "x" } });
    expect(error.code).toBe("MCP_NOT_FOUND");
    expect(error.details).toEqual({ serverId: "x" });
    expect(isNexusError(error)).toBe(true);
  });

  it("serializes to JSON", () => {
    const error = new NexusError("TIMEOUT", "slow");
    expect(error.toJSON()).toEqual({ code: "TIMEOUT", message: "slow", details: {} });
  });

  it("builds common factory errors with details", () => {
    expect(mcpNotFound("github").details.serverId).toBe("github");
    expect(capabilityNotFound("a.b.c").code).toBe("CAPABILITY_NOT_FOUND");
    const ambiguous = capabilityAmbiguous("a.b", ["a.b_2", "a.b_3"]);
    expect(ambiguous.details.candidates).toHaveLength(2);
  });

  it("wraps foreign errors without losing the cause", () => {
    const original = new Error("boom");
    const wrapped = toNexusError(original, "TOOL_EXECUTION_FAILED");
    expect(wrapped.code).toBe("TOOL_EXECUTION_FAILED");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.cause).toBe(original);
    expect(toNexusError(wrapped)).toBe(wrapped);
  });

  it("stringifies non-error values", () => {
    expect(toNexusError(42).message).toBe("42");
  });
});
