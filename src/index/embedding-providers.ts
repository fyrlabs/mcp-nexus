import { contentTokens } from "./text.js";
import { NullEmbeddingProvider, type EmbeddingProvider } from "./semantic.js";
import type { RoutingConfig } from "../config/schema.js";

const HASH_DEFAULT_DIMENSIONS = 256;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hash";
  readonly model = "";
  readonly active = true;

  constructor(readonly dimensions: number = HASH_DEFAULT_DIMENSIONS) {}

  async embed(text: string): Promise<number[]> {
    return this.embedBatchSync([text])[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.embedBatchSync(texts);
  }

  private embedBatchSync(texts: string[]): number[][] {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      const tokens = contentTokens(text);
      for (const token of tokens) {
        const bucket = fnv1a(token) % this.dimensions;
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
      let norm = 0;
      for (const value of vector) norm += value * value;
      if (norm > 0) {
        const magnitude = Math.sqrt(norm);
        for (let i = 0; i < vector.length; i++) {
          vector[i] = (vector[i] ?? 0) / magnitude;
        }
      }
      return vector;
    });
  }
}

export interface OpenAICompatibleOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
  batchSize?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 20_000;

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
}

export class OpenAICompatibleProvider implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly active = true;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    if (!options.model || options.model.trim().length === 0) {
      throw new Error("OpenAI-compatible embedding provider requires a model name");
    }
    this.name = `openai:${options.model}`;
    this.model = options.model;
    this.dimensions = options.dimensions ?? 0;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(text: string): Promise<number[] | null> {
    const results = await this.embedBatch([text]);
    return results[0] ?? null;
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    const output: (number[] | null)[] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const vectors = await this.embedOneBatch(batch);
      output.push(...vectors);
    }
    return output;
  }

  private async embedOneBatch(texts: string[]): Promise<(number[] | null)[]> {
    const response = await this.request(texts);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`embedding request failed: HTTP ${response.status} ${body.slice(0, 200)}`);
    }
    const payload = (await response.json()) as EmbeddingsResponse;
    const data = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== texts.length) {
      throw new Error(`embedding response mismatch: expected ${texts.length}, got ${data.length}`);
    }
    return data.map((entry) => {
      if (this.dimensions > 0 && entry.embedding?.length !== this.dimensions) {
        throw new Error(
          `embedding dimensions mismatch: expected ${this.dimensions}, got ${entry.embedding?.length}`,
        );
      }
      return entry.embedding ?? null;
    });
  }

  private async request(input: string[]): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

export type SemanticProviderName = "null" | "hash" | "openai";

export function createEmbeddingProvider(semantic: RoutingConfig["semantic"]): EmbeddingProvider {
  if (!semantic || semantic.provider === "null") {
    return new NullEmbeddingProvider();
  }
  if (semantic.provider === "hash") {
    return new HashingEmbeddingProvider(semantic.dimensions ?? HASH_DEFAULT_DIMENSIONS);
  }
  return new OpenAICompatibleProvider({
    model: semantic.model,
    baseUrl: semantic.baseUrl,
    apiKey: semantic.apiKey,
    dimensions: semantic.dimensions,
    batchSize: semantic.batchSize,
    timeoutMs: semantic.timeoutMs,
  });
}
