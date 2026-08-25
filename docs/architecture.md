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
| `src/lifecycle/` | Lazy start, startup timeouts, unexpected-disconnect handling, tiered idle sweeping (hot/warm/cold by usage), failure health tracking and quarantine. |
| `src/index/` | Capability ID derivation (`<server>.<domain>.<operation>`), BM25 lexical index over field-weighted metadata, alias expansion, heuristic risk classification, optional semantic layer behind `EmbeddingProvider`. |
| `src/analytics/` | Local event recording plus aggregate maintenance for routing stats and learned sequences; summary/prune/reset. |
| `src/router/` | Orchestrates search → policy filter → adaptive ranking → execute with session tracking (search→execution conversion, sequences). |
| `src/runtime/` | Composition root (`createRuntime`) wiring everything together with background indexing. |
| `src/cli/` | Commander-based CLI; each command in its own file under `commands/`. |

## Indexing lifecycle

1. On boot, persisted capabilities are **hydrated** into in-memory BM25/semantic indexes — no server is started.
2. Background indexing (`startIndexing`) starts only servers whose config hash differs from the hash recorded at their last successful index (inserts start with an empty hash, so first boot indexes once).
3. The config hash covers the command, args, cwd, tags, and env of a server definition. Env values are part of it, so changing something like `GITHUB_TOOLSETS` triggers a reindex; values under secret-looking keys (`token`, `secret`, `password`, `api_key`, `authorization`, `credential`) are redacted before hashing, so rotating a token does not force a pointless reindex and no digest of a secret is stored.
4. The config hash is recorded **after** a successful index run (`servers.set_config_hash`), so restarts detect stale definitions reliably. Servers exposing zero tools are indexed once and left alone afterwards.
5. When a reindex finds tools missing from `listTools`, they are soft-deleted (`availability = 'unavailable'`) instead of removed — learned analytics survive downstream flaps, and unavailable capabilities are excluded from search.
6. Search always works from the persisted index even while every downstream server is stopped.
7. Server ids containing dots resolve via longest-prefix matching against configured ids (`configuredServerIdFor`), never by splitting on the first dot.

## Execution safety

- The idle sweeper skips servers with in-flight calls, so `coldIdleTimeoutMs` may safely be shorter than `callTimeoutMs`.
- Consecutive lifecycle failures (failed start, unexpected disconnect) quarantine a server for an exponential window capped at `lifecycle.quarantineMaxBackoffMs`; further starts fail fast with `MCP_QUARANTINED` and its capabilities are hidden from search. One successful start clears it. Counters live in the `servers` table, so quarantine survives a restart.
- `routing.prefetch` (default on) prewarms the predicted next capability's server connection after each execution — connection start only, never tool execution.
- `routing.policies` maps risk classifications to `allow`/`deny`/`flag`; denies are enforced at the index (search), router (describe and execute), and promotion layers. Denied ids come back from describe as `missing`. Risk classification itself is a keyword heuristic over server-supplied text, so policies are a workflow guardrail rather than a security boundary (see [configuration](configuration.md#what-this-does-and-does-not-protect-against)).
- With `routing.promotion: "session"`, described capabilities become callable `nexus__<server>__<tool>` tools (passthrough zod schemas built from the downstream JSON schema, `tool_list_changed` notification, deduplicated registrations).

## Analytics hygiene

- Retention pruning runs at boot and daily (`analytics.retentionDays`).
- `bumpRouting` aggregates inside a transaction, so concurrent harness sessions on one project database never drop counts.
- Embedding vectors are cached in `capability_embeddings` keyed by provider + model + **content hash**; changed descriptions re-embed, unchanged ones never do.
- A circuit breaker (2 consecutive provider failures → 60s open, one warning) caps the cost of a dead embedding endpoint; queries fall back to lexical immediately.
- Structured log data passes through `redactUnknown` before hitting stderr or the log file.

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

## Protocol version

Nexus speaks MCP revision `2025-11-25` on both sides, via `@modelcontextprotocol/sdk` 1.x. It is a legacy-era implementation in the terms the spec now uses: it is an `initialize`-handshake server to the harness, and an `initialize`-handshake client to every downstream server.

The current spec revision is `2026-07-28`, which removes the handshake and makes the core stateless. The two eras do not interoperate directly: a modern-only client cannot talk to a legacy server, and a legacy client cannot talk to a modern-only server. Dual-era implementations bridge both, and harnesses are shipping as dual-era (Claude Code runs a v1 runtime on SDK 1.x alongside a v2 runtime on SDK 2.0), so Nexus keeps working for now. Deprecated protocol features carry a minimum twelve-month support window.

The exposed side is the **downstream client**, not the server: it breaks the first time a server you want to use ships modern-only, which is outside this project's control. That is the trigger to migrate, and the client side should move first. `@modelcontextprotocol/client` 2.x supports both eras through `versionNegotiation: 'auto'` and a cached `ConnectOptions.prior` verdict, so the migration does not force downstream servers to upgrade in step. There is an official v1 to v2 migration guide and a `@modelcontextprotocol/codemod` package. SDK 1.x is still maintained and is not deprecated, so there is no deadline beyond that trigger.
