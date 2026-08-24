import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPServerDefinition } from "../models/types.js";

export const UNRESOLVED_ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^{}]*)?\}/;

export interface TransportFactory {
  create(definition: MCPServerDefinition): Transport;
}

export class StdioTransportFactory implements TransportFactory {
  constructor(
    private readonly parentEnv: NodeJS.ProcessEnv = process.env,
    private readonly defaultEnv: Record<string, string> = getDefaultEnvironment(),
  ) {}

  create(definition: MCPServerDefinition): Transport {
    const unresolved = collectUnresolvedEnvVars(definition.env, this.parentEnv);
    if (unresolved.length > 0) {
      throw new Error(
        `Cannot start "${definition.id}": environment variables are not set: ${unresolved.join(", ")}`,
      );
    }
    const env: Record<string, string> = {};
    for (const key of Object.keys(this.defaultEnv)) {
      if (this.parentEnv[key] !== undefined) env[key] = this.parentEnv[key] as string;
    }
    for (const [key, value] of Object.entries(definition.env)) {
      env[key] = value;
    }
    return new StdioClientTransport({
      command: definition.command,
      args: [...definition.args],
      cwd: definition.cwd,
      env,
      stderr: "inherit",
    });
  }
}

function collectUnresolvedEnvVars(env: Record<string, string>, parentEnv: NodeJS.ProcessEnv): string[] {
  const missing = new Set<string>();
  for (const value of Object.values(env)) {
    let match: RegExpExecArray | null;
    const pattern = new RegExp(UNRESOLVED_ENV_PATTERN.source, "g");
    while ((match = pattern.exec(value)) !== null) {
      const [, name, fallback] = match;
      if (!fallback && parentEnv[name ?? ""] === undefined) {
        missing.add(name ?? "");
      }
    }
  }
  return [...missing].filter(Boolean);
}
