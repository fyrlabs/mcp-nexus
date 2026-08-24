import { contentHash } from "../utils/hash.js";

export interface EmbeddingProvider {
  readonly name: string;
  readonly model?: string;
  readonly dimensions: number;
  readonly active: boolean;
  embed(text: string): Promise<number[] | null>;
  embedBatch?(texts: string[]): Promise<(number[] | null)[]>;
}

export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly name = "null";
  readonly model = "";
  readonly dimensions = 0;
  readonly active = false;

  async embed(): Promise<null> {
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SemanticCacheEntry {
  vector: Float32Array;
  contentHash: string;
}

export interface SemanticCache {
  loadAll(): Map<string, SemanticCacheEntry>;
  store(entries: Map<string, SemanticCacheEntry>): void;
}

export interface SemanticIndexOptions {
  cooldownMs?: number;
  failureThreshold?: number;
  now?: () => number;
  onCircuitOpen?: () => void;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_FAILURE_THRESHOLD = 2;

export class SemanticIndex {
  private readonly vectors = new Map<string, number[]>();
  private readonly hashes = new Map<string, string>();
  private readonly cooldownMs: number;
  private readonly failureThreshold: number;
  private readonly now: () => number;
  private readonly onCircuitOpen?: () => void;
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly cache?: SemanticCache,
    options: SemanticIndexOptions = {},
  ) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.now = options.now ?? Date.now;
    this.onCircuitOpen = options.onCircuitOpen;
  }

  get enabled(): boolean {
    return this.provider.active;
  }

  get circuitOpen(): boolean {
    return this.now() < this.openUntil;
  }

  get providerName(): string {
    return this.provider.name;
  }

  get size(): number {
    return this.vectors.size;
  }

  has(id: string): boolean {
    return this.vectors.has(id);
  }

  setVector(id: string, vector: number[]): void {
    this.vectors.set(id, vector);
  }

  async hydrateFromCache(): Promise<number> {
    if (!this.cache) return 0;
    const cached = this.cache.loadAll();
    for (const [id, entry] of cached) {
      this.vectors.set(id, [...entry.vector]);
      this.hashes.set(id, entry.contentHash);
    }
    return cached.size;
  }

  async indexText(id: string, text: string): Promise<boolean> {
    let vector: number[] | null;
    try {
      vector = await this.provider.embed(text);
    } catch {
      return false;
    }
    if (!vector) return false;
    this.vectors.set(id, vector);
    this.persist([[id, vector, contentHash(text)]]);
    return true;
  }

  async indexTexts(entries: Array<{ id: string; text: string }>): Promise<number> {
    if (entries.length === 0) return 0;
    const stale = entries.filter((entry) => {
      const hash = contentHash(entry.text);
      return !this.vectors.has(entry.id) || this.hashes.get(entry.id) !== hash;
    });
    if (stale.length === 0) return 0;

    let embedded: (number[] | null)[];
    try {
      if (this.provider.embedBatch) {
        embedded = await this.provider.embedBatch(stale.map((entry) => entry.text));
      } else {
        embedded = [];
        for (const entry of stale) {
          embedded.push(await this.provider.embed(entry.text));
        }
      }
    } catch {
      return 0;
    }

    const persisted: Array<[string, number[], string]> = [];
    let stored = 0;
    for (let i = 0; i < stale.length; i++) {
      const vector = embedded[i];
      const target = stale[i];
      if (!target || !vector) continue;
      const hash = contentHash(target.text);
      this.vectors.set(target.id, vector);
      this.hashes.set(target.id, hash);
      persisted.push([target.id, vector, hash] as [string, number[], string]);
      stored++;
    }
    this.persist(persisted);
    return stored;
  }

  private persist(entries: Array<[string, number[], string]>): void {
    if (!this.cache || entries.length === 0) return;
    const payload = new Map<string, SemanticCacheEntry>();
    for (const [id, vector, hash] of entries) {
      payload.set(id, { vector: new Float32Array(vector), contentHash: hash });
    }
    this.cache.store(payload);
  }

  remove(id: string): void {
    this.vectors.delete(id);
    this.hashes.delete(id);
  }

  clear(): void {
    this.vectors.clear();
    this.hashes.clear();
  }

  async search(query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
    if (!this.enabled || this.vectors.size === 0) return [];
    if (this.circuitOpen) return [];
    let queryVector: number[] | null;
    try {
      queryVector = await this.provider.embed(query);
    } catch {
      this.failures++;
      if (this.failures >= this.failureThreshold && !this.circuitOpen) {
        this.openUntil = this.now() + this.cooldownMs;
        this.onCircuitOpen?.();
      }
      return [];
    }
    this.failures = 0;
    if (!queryVector) return [];
    const scored = [...this.vectors.entries()].map(([id, vector]) => ({
      id,
      score: Math.max(0, cosineSimilarity(queryVector, vector)),
    }));
    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
