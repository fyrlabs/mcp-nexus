const VERB_PREFIXES = new Set([
  "get",
  "list",
  "search",
  "find",
  "fetch",
  "read",
  "create",
  "update",
  "delete",
  "remove",
  "add",
  "set",
  "write",
  "send",
]);

export function sanitizeServerIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "server";
}

export function deriveCapabilityId(serverId: string, toolName: string): string {
  const words = toolName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const first = words[0];
  if (!first) return `${sanitizeServerIdPart(serverId)}.unnamed`;
  if (words.length >= 2 && VERB_PREFIXES.has(first)) {
    const domain = words.slice(1).join("_");
    return `${sanitizeServerIdPart(serverId)}.${domain}.${first}`;
  }
  return `${sanitizeServerIdPart(serverId)}.${words.join("_")}`;
}

export function withCollisionSuffix(baseId: string, taken: Set<string>): string {
  if (!taken.has(baseId)) return baseId;
  let counter = 2;
  while (taken.has(`${baseId}_${counter}`)) counter++;
  return `${baseId}_${counter}`;
}
