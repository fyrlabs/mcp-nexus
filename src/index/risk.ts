import type { RiskLevel } from "../models/types.js";

const DESTRUCTIVE_PATTERN =
  /\b(delete|destroy|drop|purge|remove|terminate|kill|revoke|wipe|truncate|uninstall|decommission)\b/i;
const WRITE_PATTERN =
  /\b(create|update|write|set|add|insert|post|put|patch|rename|move|send|edit|deploy|publish|merge|close|assign|invite|upload)\b/i;

export function classifyRisk(toolName: string, description = ""): RiskLevel {
  const text = `${toolName} ${description}`;
  if (DESTRUCTIVE_PATTERN.test(text)) return "destructive";
  if (WRITE_PATTERN.test(text)) return "write";
  return "read";
}

export function deriveKeywords(toolName: string, description: string, limit = 12): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  const candidates = [
    ...toolName.split(/[^a-zA-Z0-9]+/).filter(Boolean),
    ...(description.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []),
  ];
  for (const candidate of candidates) {
    const token = candidate.toLowerCase();
    if (seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= limit) break;
  }
  return keywords;
}

export function humanizeToolName(toolName: string): string {
  return toolName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
