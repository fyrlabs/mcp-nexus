# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versioning
follows [Semantic Versioning](https://semver.org/) — pre-1.0, so breaking changes may land in
minor releases.

## [0.6.0] - 2026-08-23

### Added

- Dynamic tool promotion (spec Mode B), opt-in via `routing.promotion: "session"`: described capabilities become directly callable `nexus__<server>__<tool>` tools for the session, with the downstream argument schema, a `tool_list_changed` notification, risk-labeled descriptions, and full policy enforcement. Default `off` keeps the minimal surface.
- Risk policy engine: `routing.policies` maps each risk classification (`destructive`/`write`/`read`/`unknown`) to `allow`/`deny`/`flag`. `deny` removes capabilities from search and blocks execution; `flag` annotates results with the risk so agents can decide explicitly.
- `mcp-nexus index --watch`: keeps running and re-indexes automatically when the config file changes (debounced, survives atomic-rename editors, re-arms if the config path moves).
- Public API: `promotedToolName`, `PROMOTED_TOOL_PREFIX`, `PolicyAction`.

## [0.5.0] - 2026-08-23

### Added

- Real semantic search, opt-in via `routing.semanticSearch` + `routing.semantic`:
  - `openai` provider works with any OpenAI-compatible `/embeddings` endpoint, including fully-local Ollama (`baseUrl: http://localhost:11434/v1`) and LM Studio; no new npm dependencies.
  - `hash` provider: deterministic local feature-hashing embeddings for offline/air-gapped use.
  - Embeddings are batched at index time and persisted in SQLite (migration v2, `capability_embeddings`), keyed by provider+model; restarts hydrate from cache and never re-embed unchanged tools.
  - Provider failures at index or query time degrade to exact + lexical search (spec fallback behavior); capability replacement now diffs instead of wiping, preserving cache entries for unchanged tools.
- Public API: `HashingEmbeddingProvider`, `OpenAICompatibleProvider`, `createEmbeddingProvider`, `EmbeddingCacheRepository`, `SemanticCacheAdapter`, `expandAliases`, `normalizeQuery`.

## [0.4.0] - 2026-08-23

### Added

- `mcp-nexus exec <capabilityId> [--args '<json>'] [--json]`: one-shot capability execution from the CLI over the same routing path as the agent control plane (lazy server start, analytics, sequence learning).
- `npm run bench`: synthetic-ecosystem benchmark measuring index build time, search latency percentiles against the spec budget, and the estimated context reduction of the 4-tool control plane versus all downstream schemas (~99.6% at 2,000 capabilities).
- Windows CI job; `doctor` command resolution is now pure Node (PATH + PATHEXT scan) instead of shelling out to `which`, so it works on Windows too.
- Public API: `expandAliases`, `normalizeQuery` exported from the package root.

## [0.3.1] - 2026-08-23

### Fixed

- `mcp-nexus serve` now writes its structured logs to `<data-dir>/logs/runtime.log` (teed to
  stderr; file-write failures degrade to stderr-only). Previously nothing wrote the file and
  `mcp-nexus logs` always reported "No log file".

### Added

- End-to-end CLI test suite: every command (init, add, remove, doctor pass/fail, index, list,
  search --explain, status, analytics, config, logs, import) driven against a real spawned
  mini MCP stdio server with isolated HOME/XDG directories.

## [0.3.0] - 2026-08-22

### Added

- Public library API via `src/index.ts` (47 exported symbols: runtime, router, index,
  storage, config utilities).
- Documentation set: architecture, configuration reference, CLI reference, harness setup.
- Example configuration and GitHub Actions CI (Node 22/24 matrix).
- `AGENTS.md` contribution conventions.

## [0.2.0] - 2026-08-22

### Added

- Full test suite mirroring `src/` under `src/tests/` (78 tests): unit coverage for every
  module plus runtime end-to-end tests over spec scenarios A–J.
- Integration tests against a real `@modelcontextprotocol/server-everything` stdio server.
- Pluggable `transportFactory` runtime option.

### Fixed

- Server config hashes now update only after successful indexing, making stale-index
  detection reliable across restarts.
- Risk classifier handles underscored tool names and inflected verbs.
- Ranker normalization keeps first-run scores meaningful (retrieval-weight base).

## [0.1.0] - 2026-08-22

### Added

- Nexus MCP control plane (`search_capabilities`, `describe_capabilities`,
  `execute_capability`, `search_servers`, `nexus://status` resource) served over stdio.
- Complete CLI: `serve`, `init`, `add`, `remove`, `list`, `status`, `doctor`, `index`,
  `search --explain`, `analytics summary|tools|sequences|reset`, `config path|template`,
  `logs`, `import` (claude / claude-code / cursor / generic).
- Runtime composition root with background indexing and idle sweeping.

## [0.0.1] - 2026-08-22

### Added

- Core domain models and structured error taxonomy.
- Layered configuration (defaults → global → project → CLI) with `${VAR}` substitution.
- SQLite persistence via `node:sqlite` with versioned migrations; zero native dependencies.
- Capability index: canonical capability IDs, BM25 lexical search, alias expansion,
  exact matching, pluggable embedding interface.
- Lazy downstream lifecycle manager with tiered idle timeouts.
- Local analytics engine with routing stats and sequence learning.
- Adaptive router with policy gates (pins/blocks), transparent scoring signals, and
  sequence prediction that never auto-executes.
