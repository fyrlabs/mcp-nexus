const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|credential)/i;

export function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY_PATTERN.test(key) && typeof item === "string" ? "[redacted]" : redactUnknown(item, depth + 1);
  }
  return output;
}

export function redactEnv(env: Record<string, string>): Record<string, string> {
  const keys = Object.keys(env);
  const output: Record<string, string> = {};
  for (const key of keys) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : env[key] ?? "";
  }
  return output;
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
