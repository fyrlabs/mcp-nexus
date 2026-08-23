import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CapabilityRepository } from "../storage/capability-repository.js";
import type { ServerRepository } from "../storage/server-repository.js";
import type { LifecycleManager } from "../lifecycle/lifecycle-manager.js";
import type {
  AnalyticsEvent,
  Capability,
  CapabilityMatch,
  MCPServerDefinition,
  SearchOptions,
} from "../models/types.js";
import type { RoutingConfig } from "../config/schema.js";
import { BM25Index, type LexicalDocument } from "./bm25.js";
import { deriveCapabilityId, withCollisionSuffix } from "./capability-id.js";
import { classifyRisk, deriveKeywords, humanizeToolName } from "./risk.js";
import { expandAliases, normalizeQuery } from "./text.js";
import { NullEmbeddingProvider, SemanticIndex, type EmbeddingProvider } from "./semantic.js";
import { configHashOf } from "../registry/registry.js";
import type { Logger } from "../utils/logger.js";

export interface CapabilityIndexEvents {
  onEvent?: (event: AnalyticsEvent) => void;
}

export interface DefinitionCatalog {
  allDefinitions(): MCPServerDefinition[];
}

export interface IndexResult {
  serverId: string;
  indexed: number;
  durationMs: number;
}

interface CandidateScores {
  lexical: number;
  exact: number;
  semantic: number;
}

const EXACT_RANK = 1000;
const SEMANTIC_RANK = 100;
const SEARCH_POOL_MULTIPLIER = 4;

export interface SemanticCacheAdapter {
  loadAll(): Map<string, Float32Array>;
  store(entries: Map<string, Float32Array>): void;
}

export class CapabilityIndex {
  private readonly bm25 = new BM25Index();
  private readonly semantic: SemanticIndex;
  private readonly documents = new Map<string, LexicalDocument>();

  constructor(
    private readonly lifecycle: LifecycleManager,
    private readonly capabilitiesRepo: CapabilityRepository,
    private readonly serversRepo: ServerRepository,
    private readonly registryCatalog: DefinitionCatalog,
    private readonly routing: RoutingConfig,
    private readonly logger: Logger,
    private readonly events: CapabilityIndexEvents = {},
    embeddingProvider: EmbeddingProvider = new NullEmbeddingProvider(),
    private readonly now: () => number = Date.now,
    semanticCache?: SemanticCacheAdapter,
  ) {
    this.semantic = new SemanticIndex(embeddingProvider, semanticCache);
  }

  get semanticEnabled(): boolean {
    return this.semantic.enabled;
  }

  async indexServer(serverId: string): Promise<IndexResult> {
    const startedAt = this.now();
    this.events.onEvent?.({ type: "server.discovered", serverId });
    const tools = await this.lifecycle.listTools(serverId);
    const capabilities = buildCapabilities(serverId, tools, this.now());
    this.capabilitiesRepo.replaceServerCapabilities(serverId, capabilities, startedAt);
    const definition = this.registryCatalog.allDefinitions().find((entry) => entry.id === serverId);
    if (definition) {
      this.serversRepo.setConfigHash(serverId, configHashOf(definition), startedAt);
    }
    await this.reloadFromStore();
    const durationMs = this.now() - startedAt;
    this.events.onEvent?.({ type: "capability.indexed", serverId });
    this.logger.info("indexed downstream server", {
      serverId,
      tools: capabilities.length,
      durationMs,
    });
    return { serverId, indexed: capabilities.length, durationMs };
  }

  async ensureIndexed(options: { force?: boolean; serverIds?: string[] } = {}): Promise<IndexResult[]> {
    const results: IndexResult[] = [];
    for (const definition of this.registryCatalog.allDefinitions()) {
      if (!definition.enabled) continue;
      if (options.serverIds && !options.serverIds.includes(definition.id)) continue;
      const record = this.serversRepo.get(definition.id);
      const stale = record?.configHash !== configHashOf(definition);
      const empty = this.capabilitiesRepo.countForServer(definition.id) === 0;
      if (!options.force && !stale && !empty) continue;
      try {
        results.push(await this.indexServer(definition.id));
      } catch (error) {
        this.logger.warn("indexing failed for server", { serverId: definition.id, error: String(error) });
      }
    }
    return results;
  }

  async rebuild(): Promise<void> {
    await this.ensureIndexed({ force: true });
  }

  async hydrate(): Promise<void> {
    if (this.capabilitiesRepo.count() === 0) return;
    await this.reloadFromStore();
  }

  async search(query: string, options: SearchOptions = {}): Promise<CapabilityMatch[]> {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) return [];
    const expandedQuery = expandAliases(normalizedQuery, this.routing.aliases);
    const limit = clampLimit(options.limit ?? this.routing.limit);

    const poolSize = Math.min(1000, Math.max(limit * SEARCH_POOL_MULTIPLIER, 32));
    const candidates = new Map<string, CandidateScores>();
    this.mergeLexical(candidates, expandedQuery);
    await this.mergeSemantic(candidates, expandedQuery, poolSize);
    this.mergeExactMatches(candidates, expandedQuery);

    return [...candidates.entries()]
      .filter(([capabilityId]) => this.isSearchable(capabilityId, options))
      .sort((a, b) => rankOf(b[1]) - rankOf(a[1]) || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([capabilityId, scores]) => this.toMatch(capabilityId, scores));
  }

  get(capabilityId: string): Capability | undefined {
    return this.capabilitiesRepo.get(capabilityId);
  }

  describe(capabilityIds: string[]): { found: Capability[]; missing: string[] } {
    const found: Capability[] = [];
    const missing: string[] = [];
    for (const id of capabilityIds) {
      const capability = this.capabilitiesRepo.get(id);
      if (capability) found.push(capability);
      else missing.push(id);
    }
    return { found, missing };
  }

  listByServer(serverId: string): Capability[] {
    return this.capabilitiesRepo.listByServer(serverId);
  }

  listAll(): Capability[] {
    return this.capabilitiesRepo.listAll();
  }

  count(): number {
    return this.capabilitiesRepo.count();
  }

  markUnavailable(serverId: string): void {
    this.setAvailability(serverId, "unavailable");
  }

  markAvailable(serverId: string): void {
    this.setAvailability(serverId, "available");
  }

  private setAvailability(serverId: string, availability: Capability["availability"]): void {
    const ids = this.capabilitiesRepo.listByServer(serverId).map((capability) => capability.capabilityId);
    this.capabilitiesRepo.setAvailability(ids, availability);
  }

  private async reloadFromStore(): Promise<void> {
    const allCapabilities = this.capabilitiesRepo.listAll();
    const documents = allCapabilities.map(toDocument);
    this.bm25.rebuild(documents);
    this.documents.clear();
    for (const document of documents) {
      this.documents.set(document.id, document);
    }
    if (!this.semantic.enabled) return;
    this.semantic.clear();
    await this.semantic.hydrateFromCache();
    const missing = allCapabilities.filter((capability) => !this.semantic.has(capability.capabilityId));
    if (missing.length === 0) return;
    const stored = await this.semantic.indexTexts(
      missing.map((capability) => ({
        id: capability.capabilityId,
        text: `${capability.title}. ${capability.description}. ${capability.metadata.keywords.join(" ")}`,
      })),
    );
    if (stored > 0) {
      this.logger.debug("embedded capabilities", { provider: this.semantic.providerName, stored });
    }
  }

  private mergeLexical(candidates: Map<string, CandidateScores>, expandedQuery: string): void {
    const lexicalScores = this.bm25.scoreQuery(expandedQuery);
    const maxLexical = maxValue(lexicalScores);
    if (maxLexical <= 0) return;
    for (const [id, rawScore] of lexicalScores) {
      if (!this.documents.has(id)) continue;
      candidates.set(id, { lexical: rawScore / maxLexical, exact: 0, semantic: 0 });
    }
  }

  private async mergeSemantic(
    candidates: Map<string, CandidateScores>,
    query: string,
    poolSize: number,
  ): Promise<void> {
    if (!this.semantic.enabled) return;
    const hits = await this.semantic.search(query, poolSize);
    const maxScore = hits[0]?.score ?? 0;
    if (maxScore <= 0) return;
    for (const hit of hits) {
      if (!this.documents.has(hit.id)) continue;
      const normalized = hit.score / maxScore;
      const existing = candidates.get(hit.id) ?? emptyScores();
      existing.semantic = Math.max(existing.semantic, normalized);
      candidates.set(hit.id, existing);
    }
  }

  private mergeExactMatches(candidates: Map<string, CandidateScores>, expandedQuery: string): void {
    for (const [capabilityId, document] of this.documents) {
      const isExact =
        capabilityId === expandedQuery ||
        document.toolName.toLowerCase() === expandedQuery ||
        `${document.serverId}.${document.toolName}`.toLowerCase() === expandedQuery;
      if (!isExact) continue;
      const existing = candidates.get(capabilityId) ?? emptyScores();
      existing.exact = 1;
      candidates.set(capabilityId, existing);
    }
  }

  private isSearchable(capabilityId: string, options: SearchOptions): boolean {
    const document = this.documents.get(capabilityId);
    if (!document) return false;
    if (options.serverIds && !options.serverIds.includes(document.serverId)) return false;
    if (this.routing.disabledCapabilities.includes(capabilityId)) return false;
    if (this.routing.disabledServers.includes(document.serverId)) return false;
    const definition = this.registryCatalog.allDefinitions().find((entry) => entry.id === document.serverId);
    return definition ? definition.enabled : true;
  }

  private toMatch(capabilityId: string, scores: CandidateScores): CapabilityMatch {
    const capability = this.capabilitiesRepo.get(capabilityId);
    const document = this.documents.get(capabilityId);
    const toolName = capability?.toolName ?? document?.toolName ?? "";
    const serverId = capability?.serverId ?? document?.serverId ?? serverPartOf(capabilityId);
    const title = capability?.title ?? humanizeToolName(toolName);
    const description = capability?.description ?? "";
    const blended = Math.max(scores.lexical, scores.semantic);
    return {
      capabilityId,
      serverId,
      toolName,
      title,
      description,
      score: scores.exact > 0 ? 1 : round3(blended),
      signals: {
        exact: scores.exact,
        lexical: round3(scores.lexical),
        semantic: round3(scores.semantic),
        userAffinity: 0,
        recentUsage: 0,
        globalUsage: 0,
        successRate: 0,
        sequence: 0,
        pin: 0,
      },
      reason: explainMatch(toolName, title, description, scores),
    };
  }
}

function buildCapabilities(serverId: string, tools: Tool[], now: number): Capability[] {
  const taken = new Set<string>();
  const capabilities: Capability[] = [];
  for (const tool of tools) {
    const baseId = deriveCapabilityId(serverId, tool.name);
    const capabilityId = withCollisionSuffix(baseId, taken);
    taken.add(capabilityId);
    const description = typeof tool.description === "string" ? tool.description : "";
    capabilities.push({
      capabilityId,
      serverId,
      toolName: tool.name,
      title: tool.title ?? humanizeToolName(tool.name),
      description,
      inputSchemaSummary: (tool.inputSchema ?? {}) as Record<string, unknown>,
      metadata: {
        tags: ["mcp", serverId],
        keywords: deriveKeywords(tool.name, description),
        risk: classifyRisk(tool.name, description),
      },
      availability: "available",
      updatedAt: now,
    });
  }
  return capabilities;
}

function toDocument(capability: Capability): LexicalDocument {
  return {
    id: capability.capabilityId,
    toolName: capability.toolName,
    title: capability.title,
    description: capability.description,
    tags: capability.metadata.tags,
    keywords: capability.metadata.keywords,
    serverId: capability.serverId,
  };
}

function emptyScores(): CandidateScores {
  return { lexical: 0, exact: 0, semantic: 0 };
}

function rankOf(scores: CandidateScores): number {
  return scores.exact * EXACT_RANK + scores.semantic * SEMANTIC_RANK + scores.lexical;
}

function maxValue(map: Map<string, number>): number {
  let max = 0;
  for (const value of map.values()) {
    if (value > max) max = value;
  }
  return max;
}

function serverPartOf(capabilityId: string): string {
  return capabilityId.split(".")[0] ?? capabilityId;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function explainMatch(
  toolName: string,
  title: string,
  description: string,
  scores: CandidateScores,
): string {
  if (scores.exact > 0) return `Exact match on "${toolName}"`;
  const parts: string[] = [];
  if (scores.semantic > 0.3) parts.push(`semantic ${(scores.semantic * 100).toFixed(0)}%`);
  if (scores.lexical > 0.3) parts.push(`lexical ${(scores.lexical * 100).toFixed(0)}%`);
  const prefix = parts.length > 0 ? `Matched via ${parts.join(", ")}` : "Matched on metadata";
  return description ? `${prefix}: ${description.slice(0, 120)}` : prefix;
}

function clampLimit(limit: number): number {
  return Math.min(100, Math.max(1, Math.floor(limit)));
}
