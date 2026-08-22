export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[] | null>;
}

export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly name = "null";
  readonly dimensions = 0;

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

export class SemanticIndex {
  private readonly vectors = new Map<string, number[]>();

  constructor(private readonly provider: EmbeddingProvider) {}

  get enabled(): boolean {
    return this.provider.dimensions > 0;
  }

  async indexText(id: string, text: string): Promise<boolean> {
    if (!this.enabled) return false;
    const vector = await this.provider.embed(text);
    if (!vector) return false;
    this.vectors.set(id, vector);
    return true;
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  clear(): void {
    this.vectors.clear();
  }

  get size(): number {
    return this.vectors.size;
  }

  async search(query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
    if (!this.enabled || this.vectors.size === 0) return [];
    const queryVector = await this.provider.embed(query);
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
