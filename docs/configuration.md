# Configuration

MCP Nexus reads its downstream server definitions from a project config file, not from your
harness config. The harness only ever configures `mcp-nexus` itself.

## Files

| File | Purpose |
|---|---|
| `project-mcp.json` (or `nexus.mcp.json`) | Project-level servers and routing. Found by walking up from the working directory, or given explicitly via `--config`. |
| `~/.config/mcp-nexus/config.json` | Global defaults shared across projects (`$XDG_CONFIG_HOME` respected). |
| `.mcp-nexus/` | Local state: `nexus.db`, logs. Never edit by hand; safe to delete. |

Resolution order — later layers override earlier ones:

```text
built-in defaults → global config → project config → CLI overrides
```

Servers merge by id across layers (a project can disable or redefine a globally-defined
server). `routing.disabledServers` always wins over `enabled: true`.

## Full example

See [`examples/project-mcp.json`](../examples/project-mcp.json). Shape summary:

```jsonc
{
  "version": 1,
  "servers": {
    "<server-id>": {
      "command": "npx",
      "args": ["-y", "@scope/server"],
      "env": { "API_TOKEN": "${API_TOKEN}" },
      "cwd": "./tools",                  // resolved relative to the config file
      "name": "Friendly Name",           // defaults to the id
      "description": "What it covers",
      "tags": ["code-review"],
      "enabled": true,
      "alwaysOn": false
    }
  },
  "routing": {
    "semanticSearch": false,
    "semantic": {
      "provider": "null",
      "model": "text-embedding-3-small",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "dimensions": 16,
      "batchSize": 64,
      "timeoutMs": 20000
    },
    "prefetch": true,   // prewarm the predicted next capability's server connection after each execution (never executes tools)
    "limit": 8,
    "minScore": 0.05,   // results below this blended score are filtered (exact matches always pass)
    "aliases": { "gh": "github" },
    "weights": { "lexical": 0.2 },       // any subset; see docs/architecture.md
    "pinnedServers": [],
    "pinnedCapabilities": ["github.pull_requests.list"],
    "disabledServers": [],
    "disabledCapabilities": []
  },
  "lifecycle": {
    "startupTimeoutMs": 20000,
    "callTimeoutMs": 120000,
    "indexTimeoutMs": 30000,
    "hotIdleTimeoutMs": 900000,
    "warmIdleTimeoutMs": 300000,
    "coldIdleTimeoutMs": 60000,
    "quarantineThreshold": 3,          // consecutive failures before quarantine; 0 disables
    "quarantineBackoffMs": 30000,      // first quarantine window, doubling per extra failure
    "quarantineMaxBackoffMs": 300000   // cap on that window
  },
  "analytics": {
    "enabled": true,
    "retentionDays": 90
  }
}
```

## Server quarantine

A downstream server that keeps failing to start would otherwise cost a full `startupTimeoutMs`
on every routed call. Nexus counts consecutive lifecycle failures per server (failed start,
unexpected disconnect) and quarantines it once the count reaches `quarantineThreshold`.

While a server is quarantined:

- start requests fail immediately with `MCP_QUARANTINED` instead of spawning the process,
- its capabilities are marked unavailable, so search stops offering them,
- `status` and `doctor` report the quarantine and the time left.

The window is `quarantineBackoffMs` doubled for each failure past the threshold, capped at
`quarantineMaxBackoffMs` (5 minutes by default). After it expires the next call retries the
server for real; one successful start clears the counter and the quarantine. Counters are
stored in SQLite, so a harness that respawns Nexus per session does not reset the backoff.
Set `quarantineThreshold` to `0` to turn the whole mechanism off.

## Environment variable substitution

Any string value may reference environment variables:

- `${VAR}` — replaced with the variable's value; if unset it stays as literal text and the
  server is flagged at start time with `MCP_START_FAILED` naming the missing variables.
- `${VAR:-fallback}` — uses `fallback` when `VAR` is unset.

Substitution happens when the config loads; secrets never appear in the index, analytics, or
logs. Use references rather than plaintext values wherever possible.

## Server ids

Ids must match `[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}` because they prefix every capability id:
`<server-id>.<domain>.<operation>` (e.g. `github.pull_requests.list`). Collisions get
deterministic `_2`, `_3…` suffixes.

## Semantic search

Off by default. Enable it by setting `routing.semanticSearch: true` and choosing a provider
under `routing.semantic`:

| Provider | Use case | Notes |
|---|---|---|
| `null` (default) | Lexical-only search | Exact + BM25 still work; no network, no model. |
| `hash` | Offline / air-gapped | Deterministic local feature-hashing embeddings (256d). Catches word-order and vocabulary overlap, not deep semantics. |
| `openai` | Real semantics | Any OpenAI-compatible `/embeddings` endpoint: cloud APIs, or a fully-local [Ollama](https://ollama.com) (`baseUrl: "http://localhost:11434/v1"`, e.g. model `nomic-embed-text`) or LM Studio. |

Behavior:

- Capability texts (title, description, keywords) are embedded once at index time in batches
  and cached in SQLite (`capability_embeddings`), keyed by provider and model. Restarts
  hydrate from the cache; only new or changed tools are embedded again.
- **Every search query is sent to the endpoint** to be embedded. Queries come from the agent
  and reflect what you asked it to do, so with a cloud endpoint that text leaves your machine
  on every search. Use `provider: "hash"` or a local Ollama endpoint if that matters. If the
  endpoint is unreachable, a circuit breaker opens after two consecutive failures (60s
  cooldown, one warning logged) and queries fall back to exact + lexical search immediately —
  search never fails because of the semantic layer.
- `dimensions` is optional for `openai`; set it to catch endpoint/model mismatches early.
- `apiKey` supports `${VAR}` substitution like every other config string. With a local Ollama
  endpoint no key is needed.
- Capability text and search queries are the only things sent to the endpoint — never tool
  arguments, tool results, secrets, or analytics.

## Tool promotion (Mode B)

With `routing.promotion: "session"` (default `"off"`), every capability returned by
`describe_capabilities` also becomes a directly callable tool for the rest of the session,
namespaced as `nexus__<server>__<tool>`. The harness receives the downstream tool's real
argument schema, a `tool_list_changed` notification is sent, and execution goes through the
same router path (policies, analytics, lazy server start) as `execute_capability`. Promoted
descriptions are prefixed with the capability's risk classification. Capabilities denied by
policy are never promoted.

Use `"off"` for the smallest possible tool surface; use `"session"` when a harness performs
better with real tool schemas after discovery.

## Risk policies

`routing.policies` maps each risk classification to an action:

```jsonc
"policies": {
  "destructive": "deny",
  "write": "allow",
  "read": "allow",
  "unknown": "flag"
}
```

- `deny` — capabilities **classified** with that risk are kept out of search results and rejected by `execute_capability` (same strength as `disabledCapabilities`). The guarantee is only as good as the classification, which is a keyword heuristic. See [what this does and does not protect against](#what-this-does-and-does-not-protect-against).
- `allow` — normal routing.
- `flag` — allowed, but search results carry the risk in their `flags` array and a
  `[flagged:<risk>]` reason prefix so the agent can decide explicitly.

Risk classifications come from the heuristic in the index (`destructive` verbs like
delete/destroy/purge; `write` verbs like create/update/send; everything else `read`).

## Risk classification

Capabilities are classified heuristically from tool names/descriptions: verbs like delete / destroy / purge / revoke map to `destructive`; create / update / send / deploy map to `write`; everything else is `read`. Risk is surfaced in search metadata and describe responses so agents can apply their own policies.

### What this does and does not protect against

The classifier is a keyword regex over a string built from the tool's own name and description, both of which the downstream server supplies. That has two consequences worth stating plainly:

- **It misses things.** No keyword list covers every dangerous verb. `archive_repository` ("Archive a repository") matches nothing in the destructive list, so it classifies `read` and passes a `destructive: "deny"` policy untouched.
- **It over-matches.** `close` and `send` are write verbs, so a tool described as "list closed issues" classifies `write` and is blocked by a `write: "deny"` policy.

So `routing.policies` is a guardrail against an agent doing something careless with an honestly-described tool. It is not a security boundary: a server that names and describes its own tools chooses its own risk class, whether by carelessness or on purpose. For capabilities where being wrong is expensive, name them explicitly in `routing.disabledCapabilities`, which matches on capability id and does not depend on the heuristic.

## Validation

Run `mcp-nexus doctor` to validate the merged config, check that referenced commands exist on
PATH (noting npx-managed packages), and list unresolved environment references.
