import type { CapabilityMatch, RiskLevel } from "../models/types.js";
import type { RoutingConfig } from "../config/schema.js";

export type PolicyAction = "allow" | "deny" | "flag";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export class PolicyEngine {
  constructor(private readonly routing: RoutingConfig) {}

  riskAction(risk: RiskLevel): PolicyAction {
    return this.routing.policies?.[risk] ?? "allow";
  }

  isServerEnabled(serverId: string, definitionEnabled: boolean): boolean {
    if (!definitionEnabled) return false;
    return !this.routing.disabledServers.includes(serverId);
  }

  evaluate(capabilityId: string, serverId: string, risk: RiskLevel = "unknown"): PolicyDecision {
    if (this.routing.disabledServers.includes(serverId)) {
      return { allowed: false, reason: `server "${serverId}" is disabled` };
    }
    if (this.routing.disabledCapabilities.includes(capabilityId)) {
      return { allowed: false, reason: `capability "${capabilityId}" is blocked` };
    }
    if (this.riskAction(risk) === "deny") {
      return { allowed: false, reason: `risk "${risk}" is denied by policy` };
    }
    return { allowed: true, reason: "allowed" };
  }

  annotate(match: CapabilityMatch): CapabilityMatch {
    if (this.riskAction(match.risk) !== "flag" || match.flags.includes(match.risk)) {
      return match;
    }
    return {
      ...match,
      flags: [...match.flags, match.risk],
      reason: `[flagged:${match.risk}] ${match.reason}`,
    };
  }

  filterMatches(
    matches: CapabilityMatch[],
    isEnabled: (serverId: string) => boolean,
  ): { allowed: CapabilityMatch[]; blocked: CapabilityMatch[] } {
    const allowed: CapabilityMatch[] = [];
    const blocked: CapabilityMatch[] = [];
    for (const match of matches) {
      const decision = this.evaluate(match.capabilityId, match.serverId, match.risk);
      if (decision.allowed && isEnabled(match.serverId)) {
        allowed.push(this.annotate(match));
      } else {
        blocked.push(match);
      }
    }
    return { allowed, blocked };
  }

  isPinned(capabilityId: string): boolean {
    return this.routing.pinnedCapabilities.includes(capabilityId);
  }

  isServerPinned(serverId: string): boolean {
    return this.routing.pinnedServers.includes(serverId);
  }
}
