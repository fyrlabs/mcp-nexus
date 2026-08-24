# CLI reference

All commands accept global flags:

```text
-c, --config <path>   explicit config file (default: discover project-mcp.json upward)
    --cwd <dir>       working directory (defaults to process cwd)
-V, --version         print version
```

## `mcp-nexus serve` (the default command)

Running bare `mcp-nexus` is equivalent to `mcp-nexus serve` — this is intentional so the
documented harness configuration (`"args": ["-y", "@fyrlabs/mcp-nexus"]`) works with no
subcommand. Runs the MCP server over stdio. Boots instantly from
the persisted index, refreshes stale servers in the background, starts `alwaysOn` servers
eagerly, and stops on SIGINT/SIGTERM.

## Setup and registry

| Command | Description |
|---|---|
| `init [--force]` | Create `project-mcp.json` in the current directory. |
| `add <name> [parts…] -d <text> -t <tag>… -e K=V… --server-cwd <dir> --always-on -- <command> [args…]` | Add/replace a downstream server in the project config. |
| `remove <name>` | Remove a server from the project config. |
| `import <file\|harness> [--from claude\|claude-code\|cursor] [--force]` | Import `mcpServers` entries from an existing harness config into the project config. |
| `list [--json]` | Show configured servers with status, indexed capability counts, and source layer. |

Example:

```bash
mcp-nexus add jira -d "Issue tracking" -t tickets \
  -e JIRA_TOKEN='${JIRA_TOKEN}' \
  -- npx -y @scope/jira-mcp
```

## Inspection

| Command | Description |
|---|---|
| `status [--json]` | Config/data/database paths, server table, running count, index size, analytics state. |
| `doctor` | Validate config, environment references (`${VAR}` resolution), command availability; exit code 1 on failures. |
| `config path` | Print which config files resolved and where state lives. |
| `config template` | Print an annotated example configuration. |
| `logs [-f] [-n 50]` | Tail `.mcp-nexus/logs/runtime.log`. |

## Indexing and search

| Command | Description |
|---|---|
| `index [-f|--force] [-s <id>] [-w|--watch]` | Start servers as needed and (re)index capabilities. Incremental by default; `--force` rebuilds everything. `--watch` keeps running and re-indexes automatically whenever the config file changes. |
| `search <query…> [-l n] [-s <id>] [--explain]` | Run the same search the agent control plane uses. `--explain` prints per-signal scores and reasons. |
| `exec <capabilityId> [-a '<json>'] [-s <id>] [--json]` | Execute a capability once from the CLI — the same routing path the agent control plane uses. Starts the owning server on demand, records analytics, and prints text content blocks. |

```bash
mcp-nexus exec github.pull_requests.list --args '{"state":"open"}' --json
```

## Benchmark

```bash
npm run bench [-- --servers 50 --tools 40 --queries 500]
```

Builds a synthetic ecosystem, measures real BM25 build/search latency against the spec targets, and estimates the context payload of all downstream tool schemas versus the 4-tool control plane.

## Analytics (local only)

| Command | Description |
|---|---|
| `analytics summary [--json]` | Calls, success rate, searches, search→execution conversion, learned sequences. |
| `analytics tools [-n n] [--json]` | Per-capability call counts, success rates, average latency, last-used time. |
| `analytics sequences [--json]` | Learned capability transitions with probabilities. |
| `analytics reset [--yes]` | Delete usage events, routing stats, and learned sequences. Indexes and configs are untouched. |
