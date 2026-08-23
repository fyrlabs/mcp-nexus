
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

interface SemanticCache {
  loadAll(): Map<string, Float32Array>;
  store(entries: Map<string, Float32Array>): void;
}

export class SemanticIndex {
  private readonly vectors = new Map<string, number[]>();

  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly cache?: SemanticCache,
  ) {}

  get enabled(): boolean {
    return this.provider.active;
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
    for (const [id, vector] of cached) {
      this.vectors.set(id, [...vector]);
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
    this.persist([[id, vector]]);
    return true;
  }

  async indexTexts(entries: Array<{ id: string; text: string }>): Promise<number> {
    if (entries.length === 0) return 0;
    const missing = entries.filter((entry) => !this.vectors.has(entry.id));
    if (missing.length === 0) return 0;

    let embedded: (number[] | null)[];
    try {
      if (this.provider.embedBatch) {
        embedded = await this.provider.embedBatch(missing.map((entry) => entry.text));
      } else {
        embedded = [];
        for (const entry of missing) {
          embedded.push(await this.provider.embed(entry.text));
        }
      }
    } catch {
      return 0;
    }

    const persisted: Array<[string, number[]]> = [];
    let stored = 0;
    for (let i = 0; i < missing.length; i++) {
      const vector = embedded[i];
      const id = missing[i]?.id;
      if (!id || !vector) continue;
      this.vectors.set(id, vector);
      persisted.push([id, vector]);
      stored++;
    }
    this.persist(persisted);
    return stored;
  }

  private persist(entries: Array<[string, number[]]>): void {
    if (!this.cache || entries.length === 0) return;
    const asFloat32 = new Map<string, Float32Array>();
    for (const [id, vector] of entries) {
      asFloat32.set(id, new Float32Array(vector));
    }
    this.cache.store(asFloat32);
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  clear(): void {
    this.vectors.clear();
  }

  async search(query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
    if (!this.enabled || this.vectors.size === 0) return [];
    let queryVector: number[] | null;
    try {
      queryVector = await this.provider.embed(query);
    } catch {
      return [];
    }
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
