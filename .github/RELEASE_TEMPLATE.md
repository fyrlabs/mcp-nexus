# Release template

The body used for a GitHub release. Copy the block below into the notes and fill it in from `CHANGELOG.md`.

**The checklist that has to pass before tagging lives in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).**

One package: `@fyrlabs/mcp-nexus`. The tag name and the release title are both `vX.Y.Z`, with no package prefix. Pre-1.0, breaking changes may land in minor releases — call them out in both the changelog and the release notes when they do.

## Release notes body

```markdown
<!-- One or two sentences: what this release is, and who should care. -->

### Breaking changes

<!-- What breaks and what to do about it. Write N/A if there are none; do not delete the section. -->

### Added

### Changed

### Fixed

### Install

​```bash
npm install -g @fyrlabs/mcp-nexus
# or run it directly:
npx @fyrlabs/mcp-nexus --help
​```

Requires Node.js 22.13 or newer.

**Full changelog:** https://github.com/fyrlabs/mcp-nexus/blob/main/CHANGELOG.md
```

## After publishing

- [ ] `@fyrlabs/mcp-nexus` resolves on npm at the new version: `npm view @fyrlabs/mcp-nexus version`
- [ ] `npx -y @fyrlabs/mcp-nexus@X.Y.Z --version` prints the released version
- [ ] Provenance shows on the npm package page
- [ ] Tags and releases still line up: every released version keeps its tag and its release page. Delete a tag only when it never had a release, or when its artifact is broken and withdrawn
- [ ] A new Unreleased section opened in `CHANGELOG.md`
