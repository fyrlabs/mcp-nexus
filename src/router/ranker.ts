import type { CapabilityMatch, ScoreSignals } from "../models/types.js";
import type { RoutingConfig } from "../config/schema.js";

export type RankingWeights = Required<NonNullable<RoutingConfig["weights"]>>;

export const DEFAULT_WEIGHTS: RankingWeights = {
  exact: 1,
  lexical: 0.2,
  semantic: 0.35,
  userAffinity: 0.15,
  recentUsage: 0.1,
  globalUsage: 0.08,
  successRate: 0.05,
  sequence: 0.07,
  pin: 0.5,
};

const PIN_FLOOR = 0.97;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const AFFINITY_SATURATION_CALLS = 20;

export interface RankerContext {
  now?: number;
}

export class Ranker {
  private readonly weights: RankingWeights;

  constructor(configured?: RoutingConfig["weights"]) {
    this.weights = { ...DEFAULT_WEIGHTS, ...configured };
  }

  get activeWeights(): RankingWeights {
    return { ...this.weights };
  }

  rank(match: CapabilityMatch, usage: UsageSignals, context: RankerContext = {}): CapabilityMatch {
    const nowMs = context.now ?? Date.now();
    const signals: ScoreSignals = {
      ...match.signals,
      userAffinity: affinity(usage.usageCount),
      recentUsage: recency(usage.lastUsedAt, nowMs),
      globalUsage: usage.globalShare,
      successRate: usage.successRate,
      sequence: clamp01(usage.sequenceProbability),
      pin: match.signals.pin,
    };
    const weighted = this.weightedSum(signals);
    const score = signals.pin > 0 ? Math.max(weighted, PIN_FLOOR) : clamp01(weighted);
    return {
      ...match,
      score: round4(score),
      signals,
      reason: buildReason(signals, match.reason, this.weights),
    };
  }

  private weightedSum(signals: ScoreSignals): number {
    let sum = 0;
    for (const key of WEIGHT_KEYS) {
      sum += this.weights[key] * signals[key];
    }
    const totalWeight = WEIGHT_KEYS.reduce((acc, key) => acc + this.weights[key], 0);
    return totalWeight > 0 ? sum / totalWeight : 0;
  }
}

export const WEIGHT_KEYS = [
  "exact",
  "lexical",
  "semantic",
  "userAffinity",
  "recentUsage",
  "globalUsage",
  "successRate",
  "sequence",
  "pin",
] as const satisfies ReadonlyArray<keyof ScoreSignals>;

export interface UsageSignals {
  usageCount: number;
  lastUsedAt: number | null;
  successRate: number;
  globalShare: number;
  sequenceProbability: number;
}

export function neutralUsageSignals(): UsageSignals {
  return {
    usageCount: 0,
    lastUsedAt: null,
    successRate: 0,
    globalShare: 0,
    sequenceProbability: 0,
  };
}

function affinity(usageCount: number): number {
  if (usageCount <= 0) return 0;
  return clamp01(Math.log1p(usageCount) / Math.log1p(AFFINITY_SATURATION_CALLS));
}

function recency(lastUsedAt: number | null, nowMs: number): number {
  if (lastUsedAt === null || lastUsedAt <= 0) return 0;
  const age = nowMs - lastUsedAt;
  if (age <= 0) return 1;
  if (age >= RECENT_WINDOW_MS) return 0;
  return clamp01(1 - age / RECENT_WINDOW_MS);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function buildReason(
  signals: ScoreSignals,
  baseReason: string,
  weights: RankingWeights,
): string {
  const contributions = WEIGHT_KEYS.map((key) => ({
    key,
    value: weights[key] * signals[key],
  }))
    .filter((entry) => entry.value >= 0.02)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((entry) => `${entry.key}=${signals[entry.key]}`);
  const signalText = contributions.length > 0 ? contributions.join(" ") : "no strong signals";
  return `${signalText}; ${baseReason}`;
}
