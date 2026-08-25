# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versioning
follows [Semantic Versioning](https://semver.org/) — pre-1.0, so breaking changes may land in
minor releases.

## [Unreleased]

## [0.10.0] - 2026-08-25

Searching a large ecosystem is now roughly 15x faster, VS Code configs import, and the privacy docs say what actually leaves your machine.

### Added

- **`import` reads VS Code configs.** VS Code stores servers under a `servers` key instead of `mcpServers`, so importing one used to report "No mcpServers found" and do nothing. Both keys work now. Entries VS Code runs over http or sse are reported and skipped, instead of failing the whole import.

### Changed

- **Search got much faster on big setups.** At 10,000 capabilities a search made about 1,400 database queries; it now makes 16. Measured on a synthetic 100-server ecosystem: 14.3ms to 0.9ms at the median. Results are unchanged.

### Fixed

- **Changing an env value now reindexes the server.** Only env variable names counted towards the staleness check, so switching something like `GITHUB_TOOLSETS` left you with the old tool list until you ran `index --force`. Values count now. Rotating a secret still does not trigger a reindex, since nothing about the tools changed.
- **Privacy docs now mention search queries.** If you point `routing.semantic` at an embedding endpoint, your search queries go there too, not just tool titles and descriptions. The docs only mentioned the latter. Nothing is sent at all with the default settings.
- **Circuit breaker docs corrected.** A dead embedding endpoint costs one slow request per 60s cooldown for as long as the outage lasts, not two requests total as previously claimed.

## [0.9.0] - 2026-08-25

Config edits are now reversible, and the README is honest about how much context you save on your particular harness.

### Added

- **Config changes are now undoable.** Every command that edits your config (`init`, `add`, `remove`, `import`) saves a snapshot of the previous version first, keeping the last 10. `config backups` lists them and `config restore` rolls back, defaulting to the most recent. A restore is itself snapshotted, so you can undo the undo.
- **Control plane reference** at `docs/mcp/`, generated from the running server, with full input schemas for all four tools and the status resource. CI fails if it drifts from the real tool surface.

### Fixed

- **A crash while saving your config can no longer corrupt it.** Config writes now go to a temp file and get renamed into place, so the file on disk is always complete and parseable.

### Changed

- README is clearer that how much context you save depends on your harness: with Copilot and VS Code it lifts a hard 128-tool cap, with Claude Code it collapses tool names and keeps servers unspawned, and elsewhere the full reduction applies.
- `docs/architecture.md` records which MCP protocol revision Nexus speaks and when that will need to change.

## [0.8.1] - 2026-08-24

Fixes from an independent adversarial review of 0.8.0, plus one import bug. No config changes needed.

### Fixed

- **`config path` no longer prints your secrets.** The COMMAND column showed env placeholders already resolved, so an API key passed as `--api-key ${MY_TOKEN}` appeared in cleartext. It now shows `${MY_TOKEN}` as written in your config.
- **A hung server no longer blocks Nexus for a minute.** If a downstream server started but never finished the MCP handshake, it ignored your `startupTimeoutMs` and stalled for up to 60 seconds per attempt, and quarantine never kicked in. Both now work as documented.
- **Indexing is no longer interrupted by the idle sweeper.** A server could be shut down mid `tools/list` when `coldIdleTimeoutMs` was short, leaving it silently missing from search.
- **`import` no longer stops at the first server you already have.** Importing a harness config that shared any server id with your existing config silently dropped every server after it.
- **`describe_capabilities` now respects your policies.** It returned full details, including the input schema, for capabilities that search hides and execute refuses. Denied ids now come back as missing.

### Changed

- Docs: risk policies are described as a workflow guardrail rather than a security boundary. Risk is guessed from each tool's own name and description, so a downstream server effectively picks its own risk class. Use `routing.disabledCapabilities` when you need a hard block.

## [0.8.0] - 2026-08-23

### Added

- **Server quarantine.** A downstream server that fails to start (or keeps crashing) three times in a row is quarantined: further calls fail instantly instead of waiting out the startup timeout, and its tools drop out of search. The quarantine lifts by itself after 30 seconds, doubling up to 5 minutes if it keeps failing; one successful start clears it. The counters are saved, so restarting your harness does not reset the backoff.
- **Health in `status` and `doctor`.** `status` shows a HEALTH column and a quarantined count, `status --json` reports per-server health, and `doctor` fails when a server is quarantined and says when it will be retried.
- Tune or disable it under `lifecycle`: `quarantineThreshold` (0 turns it off), `quarantineBackoffMs`, `quarantineMaxBackoffMs`.

### Fixed

- Downstream server output is no longer thrown away. Whatever a server prints on stderr now shows up in your harness's log next to Nexus's own output, so a server that dies at startup can actually be diagnosed.
- `remove --config some/relative/path.json` resolved the path against the shell's directory instead of `--cwd`, like `add` already did.
- `doctor` reported "not found on PATH" for any command containing a dot (`python3.11`, `node.exe`) even when it was on PATH.
- `logs -n 20` read the entire log file into memory before showing the last lines; it now reads backwards in 64 KB chunks.

### Changed

- `createNexusMcpServer` now takes a `lifecycle` dependency so `nexus://status` can report quarantined servers. Only affects code embedding Nexus as a library.
- Removed the inert `SearchOptions.includeBlocked` field (never implemented; blocked capabilities are always excluded).

## [0.7.1] - 2026-08-23

### Fixed

- Windows: the config watcher (`index --watch`) now uses stat polling instead of `fs.watch`,
  whose Windows backend has a process-fatal libuv assertion triggered by editor rename
  storms and short-path directories. Also: `assertInsideRoot` compares paths
  separator-agnostically, and the CLI test handshake awaits child exit before temp-dir
  cleanup. Windows CI is green.

## [0.7.0] - 2026-08-23

Hardening release from an independent adversarial code review. Every CRITICAL and HIGH
finding is fixed; documented behavior now matches actual behavior.

### Fixed

- **Documented launch path worked nowhere**: bare `mcp-nexus` (the exact argv every doc and
  `init` prints) printed a help menu and exited. It now serves on stdio; a protocol handshake
  test spawns the documented argv end-to-end.
- **Pins were dead code**: `pinnedCapabilities`/`pinnedServers` now feed the pin signal and
  the 0.97 floor; the inert `routing.strategy` knob was removed instead.
- **Idle sweeper could sever calls**: in-flight calls now block idle sweeping, so
  `coldIdleTimeoutMs` can safely be shorter than `callTimeoutMs`.
- **Retention pruning was a placebo**: scheduled at boot and daily; `bumpRouting` runs in a
  transaction so concurrent harness sessions no longer drop usage counts.
- **Embedding cache never invalidated**: entries are keyed by content hash (migration v3);
  changed tool descriptions re-embed, unchanged ones never do.
- **Dead embedding endpoint cost a 20s timeout per query**: a circuit breaker (2 failures ->
  60s open, warning logged once) caps outage cost; queries fall back to lexical immediately.
- Dot-containing server ids resolve via longest-prefix matching (lazy reindexing worked only
  for single-segment ids); transient tool flaps soft-delete capabilities (`unavailable`)
  instead of hard-deleting, preserving learned analytics; zero-tool servers stop respawning
  every boot; `routing.prefetch` now prewarms the predicted next capability's server
  connection (connection warm-up only, never execution); `minScore` filters results; server
  status in `status`/`list` reflects reality; log data passes through secret redaction;
  `add`/`import` warn when secrets are stored as plaintext; engines floor raised to Node
  22.13 (`node:sqlite` unflagged); CLI `search` runs through the adaptive router for true
  parity; promotion deduplicates registrations.

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
