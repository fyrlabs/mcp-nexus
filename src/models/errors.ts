export const NEXUS_ERROR_CODES = [
  "MCP_NOT_FOUND",
  "MCP_START_FAILED",
  "MCP_CONNECTION_FAILED",
  "CAPABILITY_NOT_FOUND",
  "CAPABILITY_AMBIGUOUS",
  "CAPABILITY_SCHEMA_UNAVAILABLE",
  "TOOL_EXECUTION_FAILED",
  "PERMISSION_DENIED",
  "TIMEOUT",
  "INDEX_STALE",
  "CONFIG_INVALID",
  "CONFIG_NOT_FOUND",
  "STORAGE_UNAVAILABLE",
  "INTERNAL",
] as const;

export type NexusErrorCode = (typeof NEXUS_ERROR_CODES)[number];

export interface NexusErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class NexusError extends Error {
  readonly code: NexusErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: NexusErrorCode, message: string, options: NexusErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NexusError";
    this.code = code;
    this.details = options.details ?? {};
  }

  toJSON(): { code: NexusErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isNexusError(error: unknown): error is NexusError {
  return error instanceof NexusError;
}

export function toNexusError(error: unknown, fallbackCode: NexusErrorCode = "INTERNAL"): NexusError {
  if (isNexusError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NexusError(fallbackCode, message, { cause: error });
}

export function mcpNotFound(serverId: string): NexusError {
  return new NexusError("MCP_NOT_FOUND", `MCP server "${serverId}" is not registered`, {
    details: { serverId },
  });
}

export function capabilityNotFound(capabilityId: string): NexusError {
  return new NexusError("CAPABILITY_NOT_FOUND", `Capability "${capabilityId}" was not found in the index`, {
    details: { capabilityId },
  });
}

export function capabilityAmbiguous(capabilityId: string, candidates: string[]): NexusError {
  return new NexusError(
    "CAPABILITY_AMBIGUOUS",
    `Capability id "${capabilityId}" is ambiguous. Candidates: ${candidates.join(", ")}`,
    { details: { capabilityId, candidates } },
  );
}

export function timeout(message: string): NexusError {
  return new NexusError("TIMEOUT", message);
}
