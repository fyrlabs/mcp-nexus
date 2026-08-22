import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MCPServerDefinition } from "../models/types.js";
import type { TransportFactory } from "./transport-factory.js";

export const NEXUS_CLIENT_NAME = "mcp-nexus";

export interface DownstreamClientOptions {
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
  onDisconnect?: () => void;
}

export class DownstreamClient {
  private clientPromise: Promise<Client> | null = null;
  private closed = false;

  constructor(
    readonly definition: MCPServerDefinition,
    private readonly transportFactory: TransportFactory,
    private readonly clientInfo: { name: string; version: string },
    private readonly options: DownstreamClientOptions = {},
  ) {}

  get connected(): boolean {
    return this.clientPromise !== null && !this.closed;
  }

  async connect(): Promise<Client> {
    if (this.clientPromise) return this.clientPromise;
    this.closed = false;
    const promise = this.connectOnce();
    this.clientPromise = promise;
    promise.catch(() => {
      if (this.clientPromise === promise) this.clientPromise = null;
    });
    return promise;
  }

  private async connectOnce(): Promise<Client> {
    const transport = this.transportFactory.create(this.definition);
    transport.onclose = () => {
      this.closed = true;
      this.clientPromise = null;
      this.options.onDisconnect?.();
    };
    const client = new Client(
      { name: this.clientInfo.name, version: this.clientInfo.version },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  }

  async listTools(timeoutMs?: number): Promise<Tool[]> {
    const client = await this.connect();
    const response = await client.listTools({}, timeoutMs ? { timeout: timeoutMs } : undefined);
    return response.tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | undefined,
    timeoutMs = this.options.callTimeoutMs ?? 120_000,
  ): Promise<unknown> {
    const client = await this.connect();
    const result = await client.callTool(
      { name: toolName, arguments: args ?? {} },
      undefined,
      { timeout: timeoutMs },
    );
    return result;
  }

  async close(): Promise<void> {
    const promise = this.clientPromise;
    this.clientPromise = null;
    this.closed = true;
    if (!promise) return;
    try {
      const client = await promise;
      await client.close();
    } catch {
      // closing a half-open connection is best effort
    }
  }
}
