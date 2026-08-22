import type { CapabilityMatch } from "../models/types.js";
import type { RoutingConfig } from "../config/schema.js";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export class PolicyEngine {
  constructor(private readonly routing: RoutingConfig) {}

  isServerEnabled(serverId: string, definitionEnabled: boolean): boolean {
    if (!definitionEnabled) return false;
    return !this.routing.disabledServers.includes(serverId);
  }

  evaluate(capabilityId: string, serverId: string): PolicyDecision {
    if (this.routing.disabledServers.includes(serverId)) {
      return { allowed: false, reason: `server "${serverId}" is disabled` };
    }
    if (this.routing.disabledCapabilities.includes(capabilityId)) {
      return { allowed: false, reason: `capability "${capabilityId}" is blocked` };
    }
    return { allowed: true, reason: "allowed" };
  }

  filterMatches(
    matches: CapabilityMatch[],
    isEnabled: (serverId: string) => boolean,
  ): { allowed: CapabilityMatch[]; blocked: CapabilityMatch[] } {
    const allowed: CapabilityMatch[] = [];
    const blocked: CapabilityMatch[] = [];
    for (const match of matches) {
      if (this.evaluate(match.capabilityId, match.serverId).allowed && isEnabled(match.serverId)) {
        allowed.push(match);
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
