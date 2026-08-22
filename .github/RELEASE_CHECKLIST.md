# Release checklist

Work top to bottom. Every item here exists because something went wrong once, somewhere; do not skip an item because it looks obvious, especially the ones that only fail in a published artifact.

The notes body template is in [RELEASE_TEMPLATE.md](RELEASE_TEMPLATE.md).

## 1. Before you touch a version number

- [ ] `main` is green on CI for both operating systems and both Node versions. A change that only passes on macOS is not finished.
- [ ] `npm run typecheck && npm run lint && npm test` pass from a clean checkout (`npm ci`, not a warm `node_modules`).
- [ ] No home path from a maintainer's machine is tracked. The repository is public:

```bash
git ls-files -z | grep -zv '^\.github/RELEASE_CHECKLIST\.md$' | xargs -0 grep -nlI -e '/Users/' -e '/home/' -e '\$HOME'
```

That command must print nothing. This file is excluded because the command quotes the patterns it looks for.

## 2. Versions

One package: `@fyrlabs/mcp-nexus`. Pre-1.0 policy: no major version; bump minor for user-facing capability, patch for fixes.

- [ ] `package.json` bumped with `npm version <minor|patch>` (updates the lockfile too).
- [ ] The bump lands in the same commit as (or immediately after) the change it describes.
- [ ] `CHANGELOG.md` has an entry under the new version, and nothing user-visible is missing from it.
- [ ] Breaking changes are called out in the changelog **and** will be called out in the release notes. Pre-1.0 they may ride in a minor.
- [ ] `src/utils/version.ts` reads from `package.json` — never hard-code a version anywhere else. `grep -rn "0\.[0-9]\.[0-9]" src --include="*.ts" | grep -v tests` must print nothing that smells like a release number.

## 3. Docs match the code

- [ ] `docs/configuration.md` matches `src/config/schema.ts` field for field.
- [ ] `docs/cli.md` matches `src/cli/commands/` command for command.
- [ ] `AGENTS.md` still describes the real layout and commands.
- [ ] Anything you changed in behaviour, config or the CLI is documented in the same commit.

## 4. The artifact

- [ ] `npm run build && npm pack --dry-run` — read the file list. Nothing stray (no `.mcp-nexus/`, no coverage, no examples), nothing missing (`dist/`, README, LICENSE, NOTICE).
- [ ] `node dist/cli/main.js --version` prints the new version.

## 5. Tag and publish

- [ ] `NPM_TOKEN` is present in the repository secrets and has publish rights for the `@fyrlabs` scope. Until it exists, releases still work — only the publish step stops at the gate warning.
- [ ] Tag name and GitHub release title are both `vX.Y.Z`. No package prefix.

Publishing the GitHub release is what publishes to npm; pushing the tag alone does nothing.

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main vX.Y.Z                                 # a candidate, nothing is published yet

gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes>   # this publishes
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

If the release exists but its run failed for an infra reason, re-run it with `gh workflow run release.yml -f ref=vX.Y.Z` instead of re-tagging.

## 6. Verify the published artifact, not the green check

**A green CI run proves the tests passed. It does not prove the tarball is right.**

- [ ] Install into a throwaway directory and smoke it against the registry, not this tree:

```bash
cd "$(mktemp -d)"
echo '{"version":1,"servers":{}}' > project-mcp.json
npx -y @fyrlabs/mcp-nexus@X.Y.Z doctor
npx -y @fyrlabs/mcp-nexus@X.Y.Z --version
```

- [ ] Provenance shows on https://www.npmjs.com/package/@fyrlabs/mcp-nexus
- [ ] `npm view @fyrlabs/mcp-nexus dist-tags` — `latest` points at the intended version.

## 7. Clean up

- [ ] Tags and releases line up. Every released version keeps its tag and its release page; that history is the point. Delete a tag only when it never had a release, or when its artifact is broken and withdrawn.
- [ ] Deprecate a version only if it is **actually bad**, not merely superseded. When you do, deprecate rather than unpublish: deprecation is reversible, unpublishing is not, and a version number can never be reused.

```bash
npm deprecate @fyrlabs/mcp-nexus@X.Y.Z "superseded by A.B.C" --otp=<code>
```
