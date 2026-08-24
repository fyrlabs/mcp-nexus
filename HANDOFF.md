# SESSION HANDOFF — @fyrlabs/mcp-nexus

Complete working state for a new session (human or AI) to continue with zero information
loss. Written 2026-08-24 after the v0.7.0 release. Read top to bottom; nothing important
lives outside this file, the repo itself, and the two remote systems (GitHub + npm).

---

## 1. What this project is

`@fyrlabs/mcp-nexus` — a local-first intelligent MCP router. An AI harness connects to ONE
MCP endpoint (Nexus) over stdio; Nexus manages many downstream MCP servers: indexes their
tools into SQLite, serves a 4-tool control plane (`search_capabilities`,
`describe_capabilities`, `execute_capability`, `search_servers`) plus a `nexus://status`
resource, starts downstream servers lazily, executes routed calls, and learns from local
usage (ranking signals + tool sequences). The product contract is
`mcp-nexus-product-spec.md` at the repo root — treat it as the architecture reference.
Spec sections 44 (implementation order), 38 (MVP), 39/40 (Phase 2/3) map directly to what
is/isn't built (see §7).

## 2. Current state (as of this handoff)

- **Version:** 0.7.0 — published on npm, `latest` dist-tag, provenance-signed.
- **Remotes:** GitHub `fyrlabs/mcp-nexus` (public, branch `main`), pushed and green.
- **GitHub account:** `sathvikc` (gh CLI authenticated, repo+workflow scopes).
- **npm publish:** fully automated. `NPM_TOKEN` secret is set on the repo. Publishing a
  GitHub release triggers `.github/workflows/release.yml` → lint+typecheck+test+build →
  manifest-vs-dist entry-point audit → `npm publish --access public --provenance`
  (skips if version already on registry).
- **Tags/releases:** v0.0.1 … v0.7.0. v0.0.1–v0.2.0 are GitHub milestone pages only
  (their trees predate `src/index.ts`; the release workflow's manifest gate correctly
  refuses to publish them — do NOT try to publish them, npm versions are immutable).
  v0.7.0's first release run failed (dropped source files, see §9) — tag was deleted and
  re-created at the fixed commit per the release checklist; npm never saw a broken version.
- **Tests:** 115 passing (vitest, ~2s). Typecheck (strict, zero `any`), eslint, build,
  `npm pack --dry-run` all green.
- **CI:** ubuntu+macos × node 22/24 + a Windows job. Order matters: build runs BEFORE test
  because `src/tests/cli/default-command.test.ts` spawns the built CLI for a real stdio
  MCP handshake.
- **Known consumers:** none yet. The repo owner plans to dogfood it in a real harness
  starting the day after this handoff — expect first real-world bug reports then.

## 3. Where everything lives

```text
src/
  models/        types.ts (domain types), errors.ts (NexusError taxonomy), interfaces.ts
  config/        schema.ts (zod; single source of config truth), env.ts ($ {VAR} substitution),
                 loader.ts (defaults→global→project→CLI merge), paths.ts (discovery, data dirs)
  storage/       database.ts (node:sqlite wrapper + migration runner), migrations.ts (v1..v3),
                 server-repository.ts, capability-repository.ts, analytics-repository.ts,
                 embedding-cache-repository.ts
  registry/      registry.ts (config↔DB bridge; configHashOf)
  mcp/           transport-factory.ts (pluggable; stdio default), downstream-client.ts,
                 nexus-server.ts (control plane + Mode B promotion)
  lifecycle/     lifecycle-manager.ts (lazy start, tiered idle sweep w/ in-flight protection)
  index/         capability-id.ts, text.ts (tokenizer/aliases), bm25.ts (pure-TS BM25),
                 semantic.ts (SemanticIndex + circuit breaker), embedding-providers.ts
                 (null/hash/openai-compatible), risk.ts (heuristic classifyRisk),
                 capability-index.ts (orchestrator)
  analytics/     analytics-engine.ts (events, routing_stats, sequences, prune)
  router/        router.ts, ranker.ts (weighted signals + PIN_FLOOR), policies.ts
                 (disabled/pins/risk policies), predictor.ts
  runtime/       create-runtime.ts (composition root), types.ts (NexusRuntime interface)
  cli/           cli.ts (program), main.ts (bin), config-watch.ts, config-io.ts, context.ts,
                 commands/ (serve, init, add, remove, list, status, doctor, index-cmd,
                 search, exec, analytics, config-cmd, logs, import, format)
  index.ts       public API (deliberate exports; ~55 symbols)
  tests/         MIRRORS src/ structure exactly + helpers/ (mock-downstream.ts in-memory
                 transport factory, mini-server.mjs real spawned stdio server)
scripts/benchmark.mjs   synthetic-ecosystem latency + context-reduction bench (npm run bench)
docs/            architecture.md, configuration.md, cli.md, harness-setup.md
.github/         ci.yml, release.yml, RELEASE_TEMPLATE.md, RELEASE_CHECKLIST.md,
                 pull_request_template.md
```

## 4. Key design decisions and WHY (do not "simplify" these away)

1. **`node:sqlite`, zero native deps.** Chosen over better-sqlite3 so `npx` installs never
   compile anything. Cost: engines `>=22.13` (first unflagged node:sqlite line). README and
   AGENTS.md state this.
2. **BM25 is pure TypeScript** (src/index/bm25.ts), not SQLite FTS5 — deterministic,
   unit-testable, no FTS5-availability risk across Node builds. In-memory index rebuilt from
   SQLite on boot (`hydrate`) and after each server index. 2,000 caps: 12ms build, 0.05ms p95.
3. **Capability IDs** = `<serverId>.<domain>.<operation>`; leading verb moves to the end
   (`list_pull_requests` → `github.pull_requests.list`); no-verb tools keep the full name
   (`echo` → `everything.echo`); collisions get `_2`, `_3`. **GOTCHA:** `get_pull_request`
   derives to `github.pull_request.get` — several test bugs came from assuming otherwise.
4. **Config hash lifecycle:** `registry.syncAll` inserts server rows with EMPTY hash;
   `CapabilityIndex.indexServer` records the hash only after a successful index
   (`servers.set_config_hash`). This is what makes first-boot indexing work and
   stale-detection across restarts reliable. Reindex diffs instead of delete-all: vanished
   tools are soft-deleted (`availability='unavailable'`) so learned analytics survive
   downstream flaps; `countForServer` excludes unavailable rows.
5. **Ranking:** weighted signal sum normalized by the retrieval base
   (exact+lexical+semantic weights), clamped [0,1]. Pins get a 0.97 floor via the `pin`
   signal — wired through `PolicyEngine.isPinned/isServerPinned` → `Router.search` →
   `UsageSignals.pin` → `Ranker` (`usage.pin ?? match.signals.pin`; the ranker reads the
   usage param, not match.signals). Default weights live in `DEFAULT_WEIGHTS`.
6. **Embeddings:** pluggable `EmbeddingProvider` (null/hash/openai-compatible). Vectors
   persisted in `capability_embeddings` keyed by provider+model+**content hash** (migration
   v3) — changed descriptions re-embed, unchanged never do. `SemanticIndex.indexTexts` does
   the hash staleness check; `reloadFromStore` passes ALL capabilities to it (do NOT
   pre-filter by vector presence — that bug shipped once). Circuit breaker: 2 consecutive
   provider failures → 60s open (one warn via `onCircuitOpen`), then lexical fallback.
7. **Promotion (Mode B):** `routing.promotion: "session"` promotes described capabilities as
   `nexus__<server>__<tool>` tools. The SDK's `registerTool` accepts full zod schemas
   (`AnySchema`), so downstream JSON schemas are converted to `z.object(shape).passthrough()`
   (unknown args preserved; exotic JSON-schema keywords simplified — documented limitation).
   Registrations dedupe via `promotedNames` set; `sendToolListChanged()` fires per batch.
8. **Idle sweeping** skips servers with in-flight calls (`inflightCalls` map in
   LifecycleManager) — without this, coldIdleTimeoutMs (60s) < callTimeoutMs (120s) severed
   slow calls.
9. **Secrets:** env refs `${VAR}`/`${VAR:-default}` resolve at spawn time only; config hash
   hashes env KEYS not values; logger pipes data through `redactUnknown`; add/import warn on
   plaintext secret-looking values.
10. **Bare `mcp-nexus` = `serve`** (root commander action). This was the review's CRITICAL
    C1: the documented harness argv must never regress. Guarded by
    `src/tests/cli/default-command.test.ts` (spawns built CLI, real initialize handshake).
    It requires `dist/` to exist → CI builds before testing.

## 5. Commands (all must pass before committing anything non-trivial)

```bash
npm run build       # tsc -p tsconfig.build.json -> dist/  (build BEFORE test: handshake test)
npm run typecheck   # strict tsc incl. tests
npm run lint        # eslint src
npm run test        # vitest run
npm run bench       # build + synthetic benchmark
npm pack --dry-run  # before any release commit
```

## 6. Release process (exactly)

```bash
npm version minor|patch --no-git-tag-version        # minor=capability, patch=fix; NO 1.0 while pre-1.0
# update CHANGELOG.md (new section at top; Keep-a-Changelog format)
git add -A && git commit -m "..."                    # angular conventional: type(scope): summary
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
gh release create vX.Y.Z -R fyrlabs/mcp-nexus --title "vX.Y.Z" --notes-file <notes>
# notes body: copy .github/RELEASE_TEMPLATE.md block, fill from CHANGELOG; title = version ONLY
gh run watch $(gh run list -R fyrlabs/mcp-nexus --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
# then verify: npm view @fyrlabs/mcp-nexus dist-tags --prefer-online ; npx -y @fyrlabs/mcp-nexus@X.Y.Z --version
```

- Failed run for infra reasons: `gh workflow run release.yml -R fyrlabs/mcp-nexus -f ref=vX.Y.Z`.
- If a release failed before publishing and the version is broken/withdrawn, deleting the tag
  + release and re-tagging is sanctioned (checklist §7). npm never saw the version, so it is
  reusable.
- **npm negative cache:** right after publish, `npm view` may 404 for ~30s locally. The
  registry and `npx` are authoritative — use `--prefer-online` or wait.
- Full checklist: `.github/RELEASE_CHECKLIST.md`. Notes template: `.github/RELEASE_TEMPLATE.md`.

## 7. Feature inventory (implemented = shipped in a release)

**Implemented (through 0.7.0):** layered config w/ `${VAR}` substitution; SQLite persistence
(migrations v1–v3); capability index + BM25 + aliases + exact match; pluggable embeddings
(null/hash/openai-compatible) w/ content-hash cache + circuit breaker; lazy lifecycle w/
tiered idle timeouts + in-flight protection + alwaysOn; analytics (events, routing stats,
sequences, retention pruning); adaptive ranker w/ explanations, pins (0.97 floor), minScore;
risk policies (allow/deny/flag per risk); sequence prediction (boosts only) + prefetch
(connection warm-up only); tool promotion Mode B (`routing.promotion: "session"`);
soft-delete on reindex diffs; full CLI (serve=default, init, add, remove, list, status,
doctor, index [--watch], search --explain, exec, analytics summary/tools/sequences/reset,
config path/template, logs [-f], import); importers (claude/claude-code/cursor/generic);
`nexus://status` resource; Windows CI; release automation w/ provenance.

**NOT implemented (backlog, priority order):**
1. Schema prefetch for predicted capabilities (only connection warm-up exists; spec §11
   allows preloading schemas — they're already in SQLite, so this is mostly done implicitly).
2. Server quarantine after repeated failures + health scoring (spec Phase 3; consecutive
   failure tracking does not exist yet — natural home: LifecycleManager + servers table).
3. Per-project routing profiles; capability groups.
4. Richer analytics dashboard / TUI.
5. Learned routing model (needs accumulated local data — wait for dogfooding).
6. More importers (VS Code, Windsurf, etc.).
7. Review leftovers (LOW, from the adversarial review — see §8).

## 8. Known issues, accepted limitations, landmines

**Accepted limitations (documented, do not "fix" blindly):**
- Promotion argument schemas are reconstructed from downstream JSON schemas — oneOf/formats/
  nested constraints are simplified. Documented in README + docs/configuration.md.
- Benchmark measures index-level search (BM25.topK), not the full router path. README labels
  it "index-level". If you want router-path numbers, extend scripts/benchmark.mjs.
- `classifyRisk` never returns "unknown" (heuristic always lands read/write/destructive), so
  `policies.unknown` currently only matters for capabilities with missing metadata.
- Embedding vectors for soft-deleted tools stay in the cache (harmless orphans).
- `logs -f` follow mode is interactive-only (untested by automation by design).
- Zero-tool servers never auto-refresh (hash-governed); `index --force` or `--watch` covers it.

**Landmines that bit us (will bite again if forgotten):**
- **Commander `program.opts()` inside subcommand actions returns the ROOT opts** — every
  command reads global flags this way; new commands must follow the same pattern.
- **Capability ID derivation** (see §4.3) — always verify derived IDs in tests; several bugs
  came from assuming `get_x` → `github.get_x`.
- **`git add -A` on multi-unit work creates blob commits** and has twice dropped or conflated
  changes (once dropped ALL src/ changes from a release tag — CI caught it, tag was re-cut).
  Stage per unit; commit per unit.
- **Python heredoc patches with `$` or backslashes silently no-op** on mismatch — after any
  scripted edit, grep the file to confirm the change landed (a silently-skipped
  replaceServerCapabilities edit shipped once).
- **Migration ordering:** MIGRATIONS array must stay strictly ascending; v3 was briefly
  inserted before v2 and broke everything. New migrations: append at the end, bump the
  schema-version expectations in src/tests/storage/storage.test.ts.
- **macOS FSEvents reports null filenames** in fs.watch — config-watch fires on null and
  filters by name otherwise; don't "fix" that filter.
- **SDK McpServer omits tools/list handler when zero tools are registered** → downstream
  servers with zero tools reject `tools/list` with -32601; CapabilityIndex.indexServer treats
  that as an empty tool list.
- **The handshake test needs dist/** — CI and prepublishOnly build before test; keep that
  order.
- **zod v4**: `.prefault({})` is used for nested object defaults (works, verified); `z.url()`
  for URL validation.
- **Tests that spawn real processes** (mini-server.mjs, default-command handshake,
  everything-server integration) — keep timeouts generous; integration tests skip cleanly if
  `@modelcontextprotocol/server-everything` is unresolvable.
- **`npm view` 404 right after publish** = local negative cache, not failure (§6).

**Open questions / judgment calls made (in case a future session disagrees):**
- `project-mcp.json` kept as primary filename (spec-named); `nexus.mcp.json` accepted as
  alias; user floated `nexus-mcp.json` — decision was to NOT add it unless asked again.
- `routing.strategy` knob was removed entirely (was inert) rather than implemented.
- v0.0.1–v0.2.0 will never be published to npm (broken entry points in their trees; the
  manifest gate blocks them; versions immutable).
- Public API surface (src/index.ts) is wide (~55 symbols) — reviewer called it "near-total
  export surface"; kept deliberately for library use, revisit if it becomes a maintenance
  burden.

## 9. The adversarial review (2026-08-24) — what it found and what remains

A context-free subagent reviewed the whole repo at v0.6.0. Findings C1, C2, H1–H5, and
M1–M12 (minus M2/M9-partial noted above) were ALL fixed and regression-tested in v0.7.0
(commits ff49b82, d456342, 419e153, 5c9dd1a). The full review text is in the session
transcript only — re-running an isolated review agent is cheap and recommended after the
next few features. Remaining reviewer LOWs not yet addressed:
- `remove --config` doesn't resolve relative paths against `--cwd` (add.ts does).
- `logs -n` reads the whole file into memory before tailing.
- `doctor.isExecutable` treats any command containing "." as a file path.
- Downstream `stderr: "ignore"` makes broken servers undebuggable (consider capturing to the
  runtime log).
- `transport-factory.collectUnresolvedEnvVars` reads `process.env` instead of the injected
  `parentEnv`.
- `assertInsideRoot` (config/paths.ts) is exported+tested but unused.
- `SearchOptions.includeBlocked` is unused.
- `Registry.register/remove` have no production callers (CLI edits config files directly).
- `setPredictionScores` (analytics-repository) is never called.
- Hand-rolled `joinPath` in import.ts.
- Unawaited `expect(...).resolves` in runtime.test.ts:155 area (check current line).

## 10. Conventions (enforced by AGENTS.md — read it)

- Angular conventional commits (`feat`, `fix`, `test`, `docs`, `chore`, `refactor`, `perf`,
  `build`, `ci`); commit per logical unit — NEVER `git add -A` across units (see §8).
- Version: minor for user-facing capability, patch for fixes; bump in the same commit or
  immediately after; CHANGELOG.md in sync. No 1.x before stability.
- Tests mirror `src/` under `src/tests/` exactly; helpers in `src/tests/helpers/`.
- No comments in code unless genuinely necessary; docs live in docs/ and this file.
- Strict TS: no `any`, no non-null assertions unless provably safe, `import type` for
  type-only imports, `.js` extensions on relative imports.
- Safety invariants (AGENTS.md §Safety): prediction never executes; denies/pins always win;
  secrets never leak; all state local; deleting `.mcp-nexus/` restores clean first-run state.

## 11. First steps for a new session

1. `npm ci && npm run build && npm test` — confirm 115 passing.
2. `gh run list -R fyrlabs/mcp-nexus --limit 3` — confirm CI green on main.
3. Check `gh release list -R fyrlabs/mcp-nexus` vs CHANGELOG.md — should match through v0.7.0.
4. Ask the user for dogfooding results (they start using it in a real harness imminently);
   turn reports into fixes + regression tests.
5. Pick from the backlog (§7) in priority order; follow the release process (§6) per
   milestone. Suggested next: server quarantine + health scoring (spec Phase 3, natural
   extension of the lifecycle work), then the reviewer LOW list as a single cleanup PR.
