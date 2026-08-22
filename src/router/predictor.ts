import type { AnalyticsEngine } from "../analytics/analytics-engine.js";

export class Predictor {
  constructor(private readonly analytics: AnalyticsEngine) {}

  recordTransition(previousCapabilityId: string | null, executedCapabilityId: string): void {
    if (!previousCapabilityId) return;
    this.analytics.recordSequence(previousCapabilityId, executedCapabilityId);
  }

  predictNext(previousCapabilityId: string | null, limit = 5): Map<string, number> {
    if (!previousCapabilityId) return new Map();
    return this.analytics.predictNext(previousCapabilityId, limit);
  }
}
