import { contentTokens } from "./text.js";

export interface LexicalDocument {
  id: string;
  toolName: string;
  title: string;
  description: string;
  tags: string[];
  keywords: string[];
  serverId: string;
}

const FIELD_WEIGHTS = {
  toolName: 3,
  title: 3,
  keywords: 3,
  tags: 2,
  description: 1,
  serverId: 1,
} as const;

interface Posting {
  termFrequency: Map<string, number>;
  length: number;
}

export class BM25Index {
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly documents = new Map<string, Posting>();
  private totalLength = 0;

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.documents.size;
  }

  rebuild(documents: LexicalDocument[]): void {
    this.postings.clear();
    this.documents.clear();
    this.totalLength = 0;
    for (const document of documents) {
      this.add(document);
    }
  }

  add(document: LexicalDocument): void {
    this.remove(document.id);
    const terms = documentTerms(document);
    const termFrequency = new Map<string, number>();
    for (const term of terms) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
    }
    const length = terms.length;
    this.documents.set(document.id, { termFrequency, length });
    this.totalLength += length;
    for (const [term] of termFrequency) {
      let docsForTerm = this.postings.get(term);
      if (!docsForTerm) {
        docsForTerm = new Map();
        this.postings.set(term, docsForTerm);
      }
      docsForTerm.set(document.id, termFrequency.get(term) ?? 0);
    }
  }

  remove(id: string): void {
    const existing = this.documents.get(id);
    if (!existing) return;
    this.totalLength -= existing.length;
    this.documents.delete(id);
    for (const term of existing.termFrequency.keys()) {
      const docsForTerm = this.postings.get(term);
      if (!docsForTerm) continue;
      docsForTerm.delete(id);
      if (docsForTerm.size === 0) this.postings.delete(term);
    }
  }

  has(id: string): boolean {
    return this.documents.has(id);
  }

  scoreQuery(query: string): Map<string, number> {
    const queryTerms = [...new Set(contentTokens(query))];
    const scores = new Map<string, number>();
    if (queryTerms.length === 0 || this.documents.size === 0) return scores;

    const averageLength = this.totalLength / this.documents.size || 1;
    for (const term of queryTerms) {
      const docsForTerm = this.postings.get(term);
      if (!docsForTerm || docsForTerm.size === 0) continue;
      const idf = inverseDocumentFrequency(docsForTerm.size, this.documents.size);
      for (const [docId, tf] of docsForTerm) {
        const doc = this.documents.get(docId);
        if (!doc) continue;
        const norm = this.k1 * (1 - this.b + (this.b * doc.length) / averageLength);
        const score = idf * ((tf * (this.k1 + 1)) / (tf + norm));
        scores.set(docId, (scores.get(docId) ?? 0) + score);
      }
    }
    return scores;
  }

  topK(query: string, limit: number): Array<{ id: string; score: number }> {
    const scores = this.scoreQuery(query);
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, limit));
  }
}

function inverseDocumentFrequency(documentFrequency: number, totalDocuments: number): number {
  return Math.log(1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function documentTerms(document: LexicalDocument): string[] {
  const parts: string[][] = [
    repeat(contentTokens(document.toolName), FIELD_WEIGHTS.toolName),
    repeat(contentTokens(document.title), FIELD_WEIGHTS.title),
    repeat(contentTokens(document.description), FIELD_WEIGHTS.description),
    repeat(document.tags.flatMap((tag) => contentTokens(tag)), FIELD_WEIGHTS.tags),
    repeat(document.keywords.map((k) => contentTokens(k)).flat(), FIELD_WEIGHTS.keywords),
    repeat(contentTokens(document.serverId), FIELD_WEIGHTS.serverId),
  ];
  return parts.flat();
}

function repeat(tokens: string[], times: number): string[] {
  if (times <= 1) return tokens;
  const output: string[] = [];
  for (let i = 0; i < times; i++) output.push(...tokens);
  return output;
}
