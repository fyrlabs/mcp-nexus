## What this changes

<!-- What the change does and why. Describe the behaviour as it now is, not the diff. -->

## Why

<!-- The problem being solved. If it fixes an issue, link it: Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation
- [ ] Refactor, performance or tooling

## Breaking changes

<!-- If you ticked "Breaking change": what breaks, and what a user has to do about it.
     Config schema, CLI flags, capability-id format and exported types are all public
     surface. Write "None" if nothing breaks. Pre-1.0 these may ride in a minor release,
     but they must be called out here, in CHANGELOG.md and in the release notes. -->

None.

## Safety invariants

<!-- Tick what you checked. These are the AGENTS.md invariants; a PR that breaks one is
     wrong even if every test passes. -->

- [ ] Prediction/prefetch only warms or boosts — nothing auto-executes tools
- [ ] Blocked capabilities/servers are never suggested or executed; pins outrank popularity
- [ ] No secrets in logs, index metadata, analytics or errors
- [ ] All state stays local; nothing phones home

## Testing

<!-- What you ran, and what a reviewer should run to see it work.
     A test that would have caught the bug is worth more than a test that covers the fix. -->

- [ ] `npm run typecheck && npm run lint && npm test` passes
- [ ] New or changed behaviour has a test in `src/tests/` mirroring its location, and that test fails without the change
- [ ] Failure paths covered (timeouts, malformed config, unavailable servers) where relevant

## Checklist

- [ ] Commits follow the Angular convention: `type(scope): subject`
- [ ] Docs updated if behaviour, config or the CLI changed
- [ ] `CHANGELOG.md` updated under the new/next version if this is user-visible
- [ ] No secrets, tokens or absolute local paths in the diff

## Notes for the reviewer

<!-- Anything worth knowing: a decision you were unsure about, an alternative you rejected, the part most likely to be wrong. -->
