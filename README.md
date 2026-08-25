# MCP Nexus

[![CI](https://github.com/fyrlabs/mcp-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/fyrlabs/mcp-nexus/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@fyrlabs/mcp-nexus.svg)](https://www.npmjs.com/package/@fyrlabs/mcp-nexus)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

**MCP Nexus is a local-first intelligent router for the Model Context Protocol.**
Your AI harness connects to one MCP endpoint — Nexus — while Nexus manages all of your real MCP servers behind the scenes: indexing their tools, discovering capabilities on demand, starting servers lazily, executing routed calls, and learning from local usage to rank results better over time.

```text
Before                                With MCP Nexus

AI Harness                            AI Harness
  ├── GitHub MCP   (30 tools)           └── mcp-nexus (4 control tools)
  ├── Jira MCP      (25 tools)              ├── search_capabilities
  ├── Slack MCP     (20 tools)              ├──── describe_capabilities
  ├── Figma MCP     (18 tools)              ├──── execute_capability
  ...                                   └──── search_servers
  ~90+ tool schemas in context                  │
                                     (everything else stays indexed
                                      on disk until actually needed)
```

## Why

Every connected MCP server contributes tool schemas to the model's context. Ten servers later you are burning tens of thousands of tokens on definitions the model rarely uses, and tool-selection quality degrades.

Nexus flips the model: instead of pushing every downstream schema into context, it keeps a lightweight capability index on disk and serves a tiny control plane. The agent discovers capabilities when needed (`search_capabilities`), inspects exact schemas only for what it selected (`describe_capabilities`), and executes through Nexus (`execute_capability`). All state (config, index, analytics, learned sequences) lives locally in `.mcp-nexus/`.

### How much this helps depends on your harness

Some harnesses now defer tool definitions themselves, so it is worth being precise about what Nexus adds on top.

| Harness | Without Nexus | What Nexus adds |
| --- | --- | --- |
| **GitHub Copilot / VS Code** | Hard cap of 128 tools per request. Past it, agent mode refuses to run until you manually turn tools off. | Downstream tool count stops mattering: the harness sees 4 tools regardless of how many servers you run. |
| **Claude Code** (tool search on by default) | Tool definitions are deferred, but every tool *name* plus each server's instructions still load at session start, and every configured server is connected in the background. | Names collapse to 4. Servers stay unspawned until something actually calls them. |
| **Cursor, Windsurf, older models, Bedrock / Azure / proxied setups** | Every schema loads upfront. | The full reduction below. |

On a synthetic 20-server, 400-tool ecosystem (`npm run bench`), the schemas total roughly 52,000 tokens against 544 for the Nexus control plane. That number is the upfront-loading case; where the harness already defers definitions, the saving is smaller but the lazy process startup and the tool-count ceiling still apply.

Context is not the only reason to use it. Nexus also gives you lazy server startup, per-capability policies, health quarantine, and local usage learning, none of which a harness provides.

## Quick start

```bash
# 1. Scaffold a project config
npx @fyrlabs/mcp-nexus init

# 2. Add downstream MCP servers (anything runnable over stdio)
npx @fyrlabs/mcp-nexus add github -- npx -y @modelcontextprotocol/server-github
#    or import an existing config:
npx @fyrlabs/mcp-nexus import --from claude

# 3. Point your harness at Nexus (see docs/harness-setup.md)
```

Harness configuration (Claude Code, Cursor, Codex, and other MCP clients):

```json
{
  "mcpServers": {
    "mcp-nexus": {
      "command": "npx",
      "args": ["-y", "@fyrlabs/mcp-nexus"]
    }
  }
}
```

Nexus finds `project-mcp.json` automatically by walking up from the working directory, or pass `--config ./path/to/nexus.json`.

Then, from the agent's point of view:

```text
search_capabilities  { "query": "find comments people left on my PR" }
→ github.review_comments.list  score=0.94 ...

describe_capabilities { "capabilityIds": ["github.review_comments.list"] }
→ exact input schema

execute_capability   { "capabilityId": "github.review_comments.list",
                       "arguments":  { ... } }
→ forwarded verbatim to the right server, started on demand
```

## What gets exposed vs. what stays hidden

| | Exposed to the model | Kept local |
|---|---|---|
| Control-plane tools | 4 fixed tools | — |
| Capability metadata | Only on search (small records: id, title, description, risk, score) | Full index in SQLite |
| Tool input schemas | Only for described capabilities | Persisted at index time |
| Usage analytics | — | Local events + aggregates |
| Secrets | Never (redacted from logs and CLI output) | Resolved in-process, passed to the downstream server env |

## Highlights

- **Local-first.** No cloud service, no account, no telemetry. Delete `.mcp-nexus/` and all learned state is gone.
- **Lazy execution lifecycle.** After the one-time background index, servers start only when a task needs them, stop after tiered idle timeouts (hot / warm / cold), and are never stopped mid-call. A server that keeps failing to start is quarantined for a short, growing window instead of costing a startup timeout on every call.
- **Hybrid search.** BM25 lexical ranking over weighted fields, exact id/tool matching, alias expansion (`pr → pull request`, configurable), plus optional semantic search: point `routing.semantic` at any OpenAI-compatible embeddings endpoint (cloud, or fully-local via Ollama) — embeddings are batched, cached in SQLite, and the system falls back to lexical automatically when the endpoint is down (a circuit breaker opens after two consecutive failures and suppresses calls for 60s before probing again). Search queries are sent to that endpoint too — see [Privacy](#privacy).
- **Risk policies and optional tool promotion.** Deny or flag capabilities by risk class, and (opt-in, `routing.promotion: "session"`) expose discovered tools directly as `nexus__<server>__<tool>` after discovery (argument schemas are reconstructed from the downstream JSON schema; exotic keywords are simplified). Risk classes come from a keyword heuristic over each tool's own name and description, so treat policies as a workflow guardrail against accidents, not as a security boundary against a hostile server. See [risk classification](docs/configuration.md#risk-classification).
- **Adaptive ranking with explanations.** Every result carries its signal breakdown; pinned capabilities outrank learned popularity; blocked capabilities are never suggested.
- **Sequence prediction.** Repeated tool transitions are learned locally and used to boost likely-next capabilities — prediction never auto-executes.
- **Zero native dependencies.** Storage uses Node's built-in `node:sqlite`; installing this package never compiles anything.
- **Context reduction, measured.** `npm run bench` builds a synthetic ecosystem and measures the real numbers: at 2,000 capabilities the full downstream schema payload is ~130k tokens versus ~540 tokens for the Nexus control plane (≈99.6% estimated reduction), with index-level search p95 at 0.05ms against the spec's 50ms budget (full router path adds policy and stats lookups).
- **Harness-agnostic.** Anything that speaks MCP stdio can sit in front of Nexus.

## Requirements

- Node.js **>= 22.13** (24 LTS recommended; `node:sqlite` must be available unflagged)

## Documentation

- [Configuration reference](docs/configuration.md) — every field, resolution order, env substitution
- [CLI reference](docs/cli.md) — all commands and flags
- [Architecture](docs/architecture.md) — modules, scoring model, storage schema
- [Harness setup](docs/harness-setup.md) — Claude Code, Cursor, Codex, generic MCP clients
- [`examples/project-mcp.json`](examples/project-mcp.json) — annotated starter config
- [Control plane reference](docs/mcp/) — the 4 tools and the status resource, with full input schemas, generated from the running server by [`@fyrlabs/mcp-docs`](https://www.npmjs.com/package/@fyrlabs/mcp-docs) and drift-checked in CI

## Development

```bash
git clone https://github.com/fyrlabs/mcp-nexus && cd mcp-nexus
npm install
npm run build       # tsc -> dist/
npm run test        # vitest (unit + integration, mirrors src/ structure under src/tests/)
npm run typecheck   # strict tsc, no emit
npm run lint        # eslint
```

Integration tests spin up the real `@modelcontextprotocol/server-everything` package as a downstream stdio server and route executions through a full runtime — they skip automatically if the package cannot be resolved.

See [AGENTS.md](AGENTS.md) for contribution conventions (commits, versioning, structure).

## Privacy

Nexus stores configuration caches, indexes, and analytics in `.mcp-nexus/` (or your XDG data dir). Raw tool arguments are never persisted. With the default settings (`routing.semantic.provider: "null"`) the router makes no network requests at all.

Semantic search is the one feature that sends data off the machine, and only if you turn it on. Pointing `routing.semantic` at an OpenAI-compatible endpoint sends two kinds of text there:

- **Capability text** (titles, descriptions, keywords) at index time, once per tool.
- **Your search query** on every search, to embed it for comparison. Queries are written by the agent from your conversation, so treat them as conversation content.

Tool arguments, tool results, secrets, and analytics are never sent. If the query text matters to you, use `provider: "hash"` (fully local, no network) or point `baseUrl` at a local [Ollama](https://ollama.com) instance.

## License

[Apache-2.0](LICENSE)
