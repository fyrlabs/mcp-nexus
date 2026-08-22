const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^{}]*))?\}/g;

export interface SubstitutionResult<T> {
  value: T;
  missing: string[];
}

function substituteString(input: string, lookup: (name: string) => string | undefined): SubstitutionResult<string> {
  const missing = new Set<string>();
  const value = input.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
    const resolved = lookup(name);
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return _match;
  });
  return { value, missing: [...missing] };
}

export function substituteEnvDeep<T>(value: T, lookup: (name: string) => string | undefined): SubstitutionResult<T> {
  const missing = new Set<string>();

  function walk(current: unknown): unknown {
    if (typeof current === "string") {
      const result = substituteString(current, lookup);
      for (const name of result.missing) missing.add(name);
      return result.value;
    }
    if (Array.isArray(current)) {
      return current.map(walk);
    }
    if (current !== null && typeof current === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        output[key] = walk(item);
      }
      return output;
    }
    return current;
  }

  return { value: walk(value) as T, missing: [...missing].sort() };
}

export function createProcessLookup(env: NodeJS.ProcessEnv = process.env): (name: string) => string | undefined {
  return (name) => env[name];
}
