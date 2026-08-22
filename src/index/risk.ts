import type { RiskLevel } from "../models/types.js";

const DESTRUCTIVE_PATTERN =
  /\b(delete|deletes|deleted|deleting|destroy|destroys|destroyed|destroying|drop|drops|dropped|dropping|purge|purges|purged|purging|remove|removes|removed|removing|terminate|terminates|terminated|terminating|kill|kills|killed|killing|revoke|revokes|revoked|revoking|wipe|wipes|wiping|truncat\w+|uninstall|decommission)\b/i;
const WRITE_PATTERN =
  /\b(create|creates|created|creating|update|updates|updated|updating|write|writes|writing|set|sets|setting|add|adds|added|adding|insert|inserts|inserted|inserting|post|posts|posted|posting|put|puts|patch|patches|patched|patching|rename|renames|renamed|renaming|move|moves|moved|moving|send|sends|sent|sending|edit|edits|edited|editing|deploy|deploys|deployed|deploying|publish|publishes|published|publishing|merge|merges|merged|merging|close|closes|closed|closing|assign|assigns|assigned|assigning|invite|invites|invited|inviting|upload|uploads|uploaded|uploading)\b/i;

export function classifyRisk(toolName: string, description = ""): RiskLevel {
  const text = `${toolName} ${description}`.replace(/[_-]+/g, " ");
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
