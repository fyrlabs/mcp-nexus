import { createRequire } from "node:module";

let cachedVersion = "";

export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const requireFn = createRequire(import.meta.url);
    const pkg = requireFn("../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}
