# AGENTS.md

Rules and conventions for AI agents (and humans) working in this repository.
Personal/global agent instructions live separately — see `~/.claude/CLAUDE.md` (loaded via
`~/.claude/instructions/*`). If this file and a user's global instructions conflict, the
stricter engineering rule wins inside this repo.

## Project

- Package: `@fyrlabs/mcp-nexus` — a local-first MCP router. The product contract is
  `mcp-nexus-product-spec.md` at the repo root; treat it as the architecture reference.
- Runtime: TypeScript ESM on Node.js `>= 22.5` (`node:sqlite`, no native deps).
- Do not add mandatory network dependencies, telemetry, or cloud calls.

## Commands

```bash
npm run build       # tsc -p tsconfig.build.json -> dist/
npm run typecheck   # strict tsc over src/ including tests
npm run test        # vitest run (unit + integration)
npm run lint        # eslint src/
npm run bench       # build + synthetic benchmark (search latency, context reduction)
```

All four must pass before committing anything non-trivial (`bench` is optional locally, run it when touching search/ranking). `npm pack --dry-run` before any release commit.

## Structure rules

- Source lives in `src/`; tests live in `src/tests/` and **mirror the source tree**
  (e.g. `src/router/ranker.ts` → `src/tests/router/ranker.test.ts` or a matching
  `<area>/<area>.test.ts` file). Shared test helpers go in `src/tests/helpers/`.
- Public API is only what `src/index.ts` exports. Keep exports deliberate.
- Keep subsystems behind their interfaces (transport factory, embedding provider,
  storage). No cross-module reach-ins past constructors.

## Code style

- Strict TypeScript: no `any`, no non-null assertions unless provably safe,
  `import type` for type-only imports, `.js` extensions on relative imports.
- No comments in code unless the user asks or the code is genuinely unexplainable
  without one; documentation lives in `docs/` and JSDoc-free exported types.
- Prefer small pure functions for scoring/ranking logic so they stay unit-testable
  and deterministic (inject clocks where time matters).

## Commits

- Angular conventional commits: `type(scope): summary`
  (`feat`, `fix`, `test`, `docs`, `chore`, `refactor`, `perf`, `build`, `ci`).
- Commit in reasonable units as work lands — not one giant blob at the end.
- Never commit secrets, `.mcp-nexus/` state, or generated `dist/`.

## Versioning

- Pre-1.0 policy: **no major version**. Start at `0.x.y`.
- Bump **minor** for new user-facing capability, **patch** for fixes.
- Bump in the same commit (or immediately after) that delivers the change; keep
  `package.json`, `package-lock.json`, and `CHANGELOG.md` in sync.

## Testing

- New behavior needs tests in `src/tests/` mirroring its location.
- Downstream MCP servers are simulated with `src/tests/helpers/mock-downstream.ts`
  (in-memory transport); end-to-end coverage uses the real
  `@modelcontextprotocol/server-everything` package and skips cleanly if absent.
- Failure paths are part of behavior: timeouts, malformed configs, unavailable
  servers must have explicit tests, not just happy paths.

## Safety invariants (do not break)

1. Prediction/prefetch may warm connections or boost ranking — it must never execute tools.
2. Blocked capabilities/servers are never suggested or executed; pins outrank popularity.
3. Secrets never appear in logs, index metadata, analytics, or errors (env placeholders
   resolve only at spawn time).
4. All analytics/index/config state stays local; nothing phones home.
5. Deleting `.mcp-nexus/` must always restore a clean first-run state without touching
   the user's `project-mcp.json`.
