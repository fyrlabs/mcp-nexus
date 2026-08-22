# Architecture

MCP Nexus sits between one AI harness and many downstream MCP servers. This document maps
the codebase to the [product specification](../mcp-nexus-product-spec.md).

```text
Harness (any MCP client)
   │  stdio
   ▼
src/cli/commands/serve.ts ──► src/mcp/nexus-server.ts (control plane: 4 tools + status resource)
                                   │
                                   ▼
                            src/router/router.ts ──┬── src/index/capability-index.ts (search/describe)
                                                   ├── src/router/policies.ts  (pin/block gates)
                                                   ├── src/router/ranker.ts    (signal scoring)
                                                   ├── src/router/predictor.ts (sequence boosts)
                                                   └── src/lifecycle/lifecycle-manager.ts
                                                          │ transport factory (pluggable)
                                                          ▼
                                                 Downstream MCP servers (stdio)
```

## Module map

| Module | Responsibility |
|---|---|
| `src/models/` | Domain types and the structured error taxonomy (`NexusError` with codes like `MCP_NOT_FOUND`, `TIMEOUT`, `PERMISSION_DENIED`). |
| `src/config/` | Zod schemas, layered resolution (defaults → global → project → CLI), `${VAR}` / `${VAR:-default}` substitution, path discovery. |
| `src/storage/` | `node:sqlite` wrapper, versioned migrations, repositories for servers, capabilities, usage events, routing stats, tool sequences. |
| `src/registry/` | Bridges resolved config into persistent server state; computes config hashes for staleness detection. |
| `src/mcp/` | Pluggable `TransportFactory` (stdio default), `DownstreamClient` wrapper, and the Nexus MCP server definition. |
| `src/lifecycle/` | Lazy start, startup timeouts, unexpected-disconnect handling, tiered idle sweeping (hot/warm/cold by usage). |
| `src/index/` | Capability ID derivation (`<server>.<domain>.<operation>`), BM25 lexical index over field-weighted metadata, alias expansion, heuristic risk classification, optional semantic layer behind `EmbeddingProvider`. |
| `src/analytics/` | Local event recording plus aggregate maintenance for routing stats and learned sequences; summary/prune/reset. |
| `src/router/` | Orchestrates search → policy filter → adaptive ranking → execute with session tracking (search→execution conversion, sequences). |
| `src/runtime/` | Composition root (`createRuntime`) wiring everything together with background indexing. |
| `src/cli/` | Commander-based CLI; each command in its own file under `commands/`. |

## Indexing lifecycle

1. On boot, persisted capabilities are **hydrated** into in-memory BM25/semantic indexes — no server is started.
2. Background indexing (`startIndexing`) starts only servers that are new or whose config hash changed since their last successful index.
3. The config hash is recorded **after** a successful index run (`servers.set_config_hash`), so restarts detect stale definitions reliably.
4. Search always works from the persisted index even while every downstream server is stopped.

## Scoring model

Signals per match: `exact`, `lexical` (normalized BM25), `semantic` (optional provider),
`userAffinity` (log-scaled usage), `recentUsage` (24h decay), `globalUsage` (relative share),
`successRate`, `sequence` (probability from `tool_sequences`), `pin`.

Default weights:

```text
exact 1.0 · lexical 0.20 · semantic 0.35 · userAffinity 0.15 · recentUsage 0.10
globalUsage 0.08 · successRate 0.05 · sequence 0.07 · pin 0.50
```

The weighted sum is normalized by the retrieval base (`exact + lexical + semantic`) so
first-run scores stay meaningful, clamped to `[0, 1]`. Pinned results get a floor of 0.97,
which outranks anything popularity alone can produce. Every result carries its full signal
breakdown and a human-readable reason.

## Storage schema (SQLite)

Created by migration v1 (`src/storage/migrations.ts`):

- `servers` — id, name, config_hash (last successfully indexed definition), status, timestamps
- `capabilities` — capability_id PK, server_id FK, tool_name, title, description, `input_schema_json`,
  `metadata_json`, risk_level, availability (unique per server+tool)
- `usage_events` — append-only event log with type/session/server/capability/latency/success
- `routing_stats` — per-capability aggregates maintained incrementally on execution outcomes
- `tool_sequences` — transition counts with normalized probabilities

Deleting `.mcp-nexus/` removes all of it; nothing outside that directory is written except
when no project config exists (then state goes to `$XDG_DATA_HOME/mcp-nexus`).

## Extension points

- `TransportFactory` — swap stdio for any MCP transport (tests use in-memory pairs).
- `EmbeddingProvider` — plug a local or remote embedding model; when absent, Nexus falls back
  to exact + lexical search automatically.
- Ranking weights are config-driven (`routing.weights`); scoring stays deterministic and injectable
  clocks keep tests stable.

## Safety properties

- Prediction boosts ranking only; it never calls tools.
- `routing.disabledCapabilities` / `disabledServers` are enforced in both search filtering and execution.
- Env references resolve only at spawn time; unresolved references fail that server's start with a
  clear error and never leak values into logs or errors.
