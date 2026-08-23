import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BM25Index,
  createNexusMcpServer,
  expandAliases,
  normalizeQuery,
} from "../dist/index.js";

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || args[index + 1] === undefined) return fallback;
  const parsed = Number.parseInt(args[index + 1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SERVER_COUNT = flagValue("servers", 20);
const TOOLS_PER_SERVER = flagValue("tools", 20);
const QUERY_COUNT = flagValue("queries", 200);

const DOMAINS = ["pull_requests", "issues", "messages", "documents", "pipelines", "tickets", "boards", "repos", "users", "files", "comments", "releases", "branches", "commits", "wikis", "labels", "milestones", "hooks", "deploys", "secrets"];
const OPERATIONS = ["list", "get", "search", "create", "update", "delete", "archive", "restore", "export", "assign"];
const DESCRIPTION_TAIL = [
  "with pagination, filtering, and sorting options",
  "returning full metadata for the matching records",
  "including comments, attachments, and history",
  "scoped to the current project and team permissions",
  "supporting batch operations and dry-run mode",
];

function makeDocs() {
  const documents = [];
  const schemas = {};
  for (let s = 0; s < SERVER_COUNT; s++) {
    const serverId = `srv${s}`;
    for (let t = 0; t < TOOLS_PER_SERVER; t++) {
      const domain = DOMAINS[(s + t) % DOMAINS.length];
      const operation = OPERATIONS[(t * 7 + s) % OPERATIONS.length];
      const toolName = `${operation}_${domain}`;
      const capabilityId = `${serverId}.${domain}.${operation}`;
      const description = `${operation.replace(/^\w/, (c) => c.toUpperCase())} ${domain.replace(/_/g, " ")} ${DESCRIPTION_TAIL[(s * 3 + t) % DESCRIPTION_TAIL.length]}.`;
      documents.push({
        id: capabilityId,
        toolName,
        title: `${operation} ${domain.replace(/_/g, " ")}`,
        description,
        tags: ["mcp", serverId, domain],
        keywords: [...toolName.split("_"), ...description.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 8)],
        serverId,
      });
      schemas[capabilityId] = {
        type: "object",
        properties: {
          id: { type: "string", description: `Unique ${domain} identifier` },
          limit: { type: "number", description: "Maximum number of results", default: 20 },
          offset: { type: "number", description: "Pagination offset", default: 0 },
          filter: { type: "object", description: "Field filters", properties: { status: { type: "string", enum: ["open", "closed", "all"] }, assignee: { type: "string" } } },
          include: { type: "array", items: { type: "string" }, description: "Related records to embed" },
        },
        required: ["id"],
      };
    }
  }
  return { documents, schemas };
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

async function measureControlPlaneBytes() {
  const stub = {
    router: { async search() { return []; }, async describe() { return { found: [], missing: [] }; }, async execute() { return {}; }, async searchServers() { return []; } },
    registry: { allDefinitions: () => [], definition: () => undefined },
    index: { count: () => 0 },
    analytics: { enabled: true },
  };
  const server = createNexusMcpServer(stub);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "benchmark", version: "0.0.0" }, {});
  void server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  await client.close();
  return tools.tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
}

const { documents, schemas } = makeDocs();
const totalCapabilities = documents.length;

process.stdout.write(`MCP Nexus benchmark\n`);
process.stdout.write(`synthetic ecosystem: ${SERVER_COUNT} servers x ${TOOLS_PER_SERVER} tools = ${totalCapabilities} capabilities\n\n`);

const buildStart = performance.now();
const index = new BM25Index();
index.rebuild(documents);
const buildMs = performance.now() - buildStart;
process.stdout.write(`index build: ${buildMs.toFixed(1)}ms for ${totalCapabilities} documents\n`);

const queries = [];
for (let q = 0; q < QUERY_COUNT; q++) {
  const domain = DOMAINS[q % DOMAINS.length];
  const operation = OPERATIONS[(q * 3) % OPERATIONS.length];
  queries.push(normalizeQuery(`${operation} ${domain.replace(/_/g, " ")} ${q % 5 === 0 ? "pr" : ""}`));
}

const latencies = [];
let hitCount = 0;
for (const query of queries) {
  const expanded = expandAliases(query);
  const start = performance.now();
  const results = index.topK(expanded, 8);
  latencies.push(performance.now() - start);
  if (results.length > 0) hitCount++;
}
latencies.sort((a, b) => a - b);
const p50 = percentile(latencies, 50);
const p95 = percentile(latencies, 95);
process.stdout.write(`search: ${QUERY_COUNT} queries -> p50 ${p50.toFixed(2)}ms, p95 ${p95.toFixed(2)}ms (spec target: <50ms p95), hit rate ${((hitCount / QUERY_COUNT) * 100).toFixed(0)}%\n\n`);

const downstreamBytes = Object.values(schemas).reduce((sum, schema) => sum + JSON.stringify(schema).length, 0);
const controlBytes = await measureControlPlaneBytes();
const reduction = (1 - controlBytes / downstreamBytes) * 100;
process.stdout.write(`estimated context payload (chars; tokens ~ chars/4):\n`);
process.stdout.write(`  all downstream tool schemas: ${downstreamBytes.toLocaleString()} chars (~${Math.round(downstreamBytes / 4).toLocaleString()} tokens)\n`);
process.stdout.write(`  nexus control plane (4 tools): ${controlBytes.toLocaleString()} chars (~${Math.round(controlBytes / 4).toLocaleString()} tokens)\n`);
process.stdout.write(`  estimated schema-load reduction: ${reduction.toFixed(1)}% (estimate, not a measured model-context delta)\n`);
