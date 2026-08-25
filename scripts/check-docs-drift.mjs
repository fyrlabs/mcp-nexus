// Compares the committed control-plane manifest against the one the current build
// produces. Only the surface agents actually see is compared: tools, resources,
// resource templates, prompts and the server instructions. `server.version` and
// `connection` are deliberately ignored — the committed manifest documents the
// published package (so its install snippet is the npx command users should run),
// while this check runs the local build, and both differ every release by design.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const committedPath = process.argv[2] ?? "docs/mcp/mcp-manifest.json";
const out = mkdtempSync(join(tmpdir(), "nexus-docs-drift-"));

function surfaceOf(manifest) {
  const tools = (manifest.tools ?? []).map((tool) => ({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? null,
  }));
  tools.sort((a, b) => a.name.localeCompare(b.name));
  const names = (list) => (list ?? []).map((item) => item.name ?? item.uri ?? item.uriTemplate).sort();
  return {
    tools,
    resources: names(manifest.resources),
    resourceTemplates: names(manifest.resourceTemplates),
    prompts: names(manifest.prompts),
    instructions: manifest.instructions ?? null,
  };
}

try {
  execFileSync(
    "npx",
    ["-y", "@fyrlabs/mcp-docs", "generate", "--manifest-only", "--command", "node dist/cli/main.js", "--out", out],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  const committed = surfaceOf(JSON.parse(readFileSync(committedPath, "utf8")));
  const live = surfaceOf(JSON.parse(readFileSync(join(out, "mcp-manifest.json"), "utf8")));

  if (JSON.stringify(committed) === JSON.stringify(live)) {
    process.stdout.write(`In sync: ${committedPath} matches the control plane this build serves.\n`);
    process.exit(0);
  }

  process.stderr.write(`Drift detected against ${committedPath}.\n\n`);
  const committedNames = new Set(committed.tools.map((tool) => tool.name));
  const liveNames = new Set(live.tools.map((tool) => tool.name));
  for (const name of liveNames) if (!committedNames.has(name)) process.stderr.write(`  + tool "${name}" is new\n`);
  for (const name of committedNames) if (!liveNames.has(name)) process.stderr.write(`  - tool "${name}" is gone\n`);
  for (const tool of live.tools) {
    const before = committed.tools.find((candidate) => candidate.name === tool.name);
    if (before && JSON.stringify(before) !== JSON.stringify(tool)) {
      process.stderr.write(`  ~ tool "${tool.name}" changed its description or schema\n`);
    }
  }
  if (JSON.stringify(committed.instructions) !== JSON.stringify(live.instructions)) {
    process.stderr.write("  ~ server instructions changed\n");
  }
  for (const key of ["resources", "resourceTemplates", "prompts"]) {
    if (JSON.stringify(committed[key]) !== JSON.stringify(live[key])) {
      process.stderr.write(`  ~ ${key} changed\n`);
    }
  }
  process.stderr.write(
    '\nRegenerate with:\n  npx -y @fyrlabs/mcp-docs generate --command "npx -y @fyrlabs/mcp-nexus" --out docs/mcp\n' +
      "(run it after the new version is published, so the install snippet stays correct)\n",
  );
  process.exit(1);
} finally {
  rmSync(out, { recursive: true, force: true });
}
