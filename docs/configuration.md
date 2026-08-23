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
    "strategy": "adaptive",
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
    "prefetch": true,
    "limit": 8,
    "minScore": 0.05,
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
    "coldIdleTimeoutMs": 60000
  },
  "analytics": {
    "enabled": true,
    "retentionDays": 90
  }
}
```

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
- Query embeddings happen per search. If the endpoint is unreachable, Nexus logs a warning and
  falls back to exact + lexical search for that query — search never fails because of the
  semantic layer.
- `dimensions` is optional for `openai`; set it to catch endpoint/model mismatches early.
- `apiKey` supports `${VAR}` substitution like every other config string. With a local Ollama
  endpoint no key is needed.
- Only capability text is ever sent to the endpoint — never tool arguments, secrets, or
  analytics.

## Risk classification

Capabilities are classified heuristically from tool names/descriptions: verbs like delete /
destroy / purge / revoke map to `destructive`; create / update / send / deploy map to `write`;
everything else is `read`. Risk is surfaced in search metadata and describe responses so agents
can apply their own policies.

## Validation

Run `mcp-nexus doctor` to validate the merged config, check that referenced commands exist on
PATH (noting npx-managed packages), and list unresolved environment references.
