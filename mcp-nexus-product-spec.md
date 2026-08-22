# MCP Nexus — Product & Engineering Specification

## 1. Product Overview

### Product name
**MCP Nexus**

### CLI / package name
`mcp-nexus`

### One-line description
**MCP Nexus is a local-first intelligent MCP router that lets an AI harness connect to many MCP servers through a single MCP endpoint while dynamically discovering and exposing only the capabilities relevant to the current task.**

### Core problem
An AI coding/agent harness can become overloaded when users configure many MCP servers. Every connected server may contribute tool definitions, descriptions, schemas, and metadata to the model context. As the number of MCPs grows, context usage, tool-selection complexity, latency, and configuration management get worse.

MCP Nexus solves this by sitting between the harness and the user's MCP ecosystem.

The harness connects to **one MCP server: MCP Nexus**.

MCP Nexus manages the user's real MCP servers locally and provides:

- MCP/server registry
- Capability and tool indexing
- Semantic discovery
- Keyword search
- Lazy MCP startup/connection
- Dynamic capability loading
- Tool routing
- Local usage analytics
- Adaptive ranking and prediction
- Optional preloading of frequently used tools
- Local-only configuration, history, and analytics

---

# 2. Product Goals

## Primary goals

1. Reduce the amount of MCP tool schema/context exposed to the AI agent.
2. Allow users to manage many MCP servers behind one MCP endpoint.
3. Make relevant MCP capabilities discoverable by natural language and keywords.
4. Load/start only the MCPs and tools required for a task.
5. Learn locally from usage to reduce unnecessary discovery calls over time.
6. Keep all configuration, analytics, indexes, and usage history local.
7. Work with existing MCP servers without requiring them to be modified.
8. Be harness-agnostic wherever possible.
9. Be easy to install and configure from a local project.
10. Fail safely and transparently when downstream MCPs are unavailable.

## Secondary goals

- Support project-specific MCP configurations.
- Allow a global configuration plus project overrides.
- Allow users to explicitly pin important MCPs/tools.
- Provide observability for routing decisions.
- Support multiple transport mechanisms supported by downstream MCP servers.
- Make the core architecture extensible so new ranking/indexing strategies can be added later.

## Non-goals for v1

- Cloud-hosted analytics.
- Multi-user SaaS infrastructure.
- Centralized account/login system.
- Replacing MCP servers.
- Building a general-purpose AI agent.
- Automatically executing arbitrary tools without the model explicitly requesting execution.
- Sending user prompts, tool arguments, or analytics to a remote service.

---

# 3. Core Product Concept

The normal model:

```text
AI Harness
   |
   +-- GitHub MCP
   +-- Jira MCP
   +-- Slack MCP
   +-- Figma MCP
   +-- Notion MCP
   +-- AWS MCP
   +-- ...
```

MCP Nexus model:

```text
                    AI Harness
                        |
                        | ONE MCP CONNECTION
                        v
               +-------------------+
               |     MCP Nexus     |
               |-------------------|
               | Registry          |
               | Capability Index  |
               | Semantic Search   |
               | Router            |
               | Lifecycle Manager |
               | Adaptive Ranking  |
               | Local Analytics   |
               +---------+---------+
                         |
        +----------------+----------------+
        |                |                |
        v                v                v
   GitHub MCP        Jira MCP         Figma MCP
        |                |                |
       API              API              API
```

The agent should **not** receive every downstream tool definition.

Instead it should be able to:

1. Discover relevant capabilities.
2. Inspect the schemas/details of selected capabilities.
3. Invoke selected capabilities through Nexus.

---

# 4. Core Design Principle

## Metadata first, schemas on demand

MCP Nexus must separate:

- lightweight capability metadata
- complete tool schemas
- actual tool execution

A capability index entry should be small enough that many capabilities can be indexed without injecting all schemas into the model context.

Example metadata:

```json
{
  "capabilityId": "github.pull_requests.list",
  "serverId": "github",
  "toolName": "list_pull_requests",
  "title": "List pull requests",
  "description": "Find pull requests using repository, state, author, reviewer, and label filters.",
  "tags": ["github", "pull-request", "code-review", "development"],
  "keywords": ["PR", "pull request", "review", "repository"],
  "risk": "read",
  "availability": "available"
}
```

The complete MCP tool schema is fetched only when needed.

---

# 5. Agent Interaction Model

MCP Nexus should expose a very small control-plane API to the AI harness.

Recommended initial tools:

### `search_capabilities`

Search the indexed MCP ecosystem using natural language, keywords, tags, server name, or capability ID.

Example:

```json
{
  "query": "find pull request review comments",
  "limit": 8
}
```

Response:

```json
{
  "results": [
    {
      "capabilityId": "github.pull_requests.comments.list",
      "serverId": "github",
      "toolName": "list_review_comments",
      "score": 0.96,
      "reason": "Matches pull request comments and code review context"
    }
  ]
}
```

### `describe_capabilities`

Return the full schemas/details for selected capability IDs.

Example:

```json
{
  "capabilityIds": [
    "github.pull_requests.get",
    "github.pull_requests.comments.list"
  ]
}
```

### `execute_capability`

Execute a selected downstream capability.

Example:

```json
{
  "capabilityId": "github.pull_requests.comments.list",
  "arguments": {
    "repository": "org/repo",
    "pullRequest": 123
  }
}
```

The gateway resolves the capability to the underlying MCP server/tool and forwards the request.

### Optional `search_servers`

Useful when the agent needs domain-level discovery first.

Example:

```json
{
  "query": "project management and issue tracking"
}
```

Response could rank:

```text
Jira       0.97
Linear     0.91
Asana      0.52
Notion     0.28
```

This should be optional. Prefer capability search when enough metadata exists.

---

# 6. Dynamic Tool Exposure

MCP Nexus should support two routing modes.

## Mode A — Control-plane execution

The agent always uses:

```text
search_capabilities
 describe_capabilities
 execute_capability
```

No dynamic downstream tools are exposed as separate MCP tools.

Advantages:

- smallest MCP surface
- simplest implementation
- maximum context control
- easiest analytics
- consistent interface

This should be the default mode for v1.

## Mode B — Dynamic tool promotion

Nexus can temporarily expose selected downstream tools directly after discovery.

Example:

```text
Initial:
  search_capabilities
  describe_capabilities
  execute_capability

After discovery:
  github.get_pull_request
  github.get_review_comments
  jira.get_issue
```

This mode can reduce extra execution indirection if a harness performs better with real tool schemas, but it is more complex and harness-dependent.

Implement this behind a feature flag or later phase.

---

# 7. Capability Index

The index is the heart of MCP Nexus.

## What is indexed

For every downstream MCP:

- server ID
- server name
- server description
- server tags
- transport type
- command/url configuration metadata
- tool names
- tool descriptions
- input schema summary
- capability IDs
- tags
- keywords
- risk level
- availability
- estimated latency
- usage statistics
- success rate
- last-used time
- popularity score
- user/project affinity

Do not persist secret environment values in the index.

## Capability ID

Canonical format:

```text
<serverId>.<domain>.<operation>
```

Example:

```text
github.pull_requests.get
github.pull_requests.comments.list
jira.issues.search
slack.messages.search
```

If two tools collide, append a deterministic suffix.

---

# 8. Search / Retrieval Strategy

MCP Nexus should support a hybrid retrieval strategy.

## Layer 1 — exact matching

Fast lookup for:

- capability ID
- server ID
- tool name
- aliases
- explicit keywords

## Layer 2 — lexical search

Use BM25 or equivalent ranking for:

- descriptions
- names
- tags
- keywords

## Layer 3 — semantic search

Use embeddings for natural-language intent matching.

Example:

```text
"Who reviewed my PR?"
```

should match:

```text
github.pull_requests.reviews.list
```

without requiring the exact words "list reviews".

## Layer 4 — adaptive ranking

Adjust ranking using local usage and routing history.

Conceptual score:

```text
finalScore =
    semanticScore * 0.35 +
    lexicalScore  * 0.20 +
    userAffinity  * 0.15 +
    recentUsage   * 0.10 +
    globalUsage   * 0.08 +
    successRate   * 0.05 +
    taskAffinity  * 0.07
```

Weights must be configurable and should not be treated as a permanent API contract.

---

# 9. Adaptive / Analytics Engine

Analytics are **100% local by default**.

The analytics system exists for two reasons:

1. Observability.
2. Improving routing and reducing discovery overhead.

## Events to collect

At minimum:

```text
server discovered
server started
server connected
server disconnected
capability indexed
capability searched
capability selected
capability described
capability executed
execution succeeded
execution failed
search converted to execution
search produced no useful result
predicted capability used
predicted capability unused
```

## Tool usage metrics

Track:

- total calls
- successful calls
- failed calls
- average latency
- recent calls
- first-seen time
- last-used time
- user/project frequency
- search-to-execution conversion rate
- prediction accuracy
- schema fetch frequency
- startup frequency
- startup latency

Do not store raw secrets or sensitive arguments by default.

---

# 10. Hot / Warm / Cold Tool Model

Tools should be classified into three logical states.

## HOT

Frequently or predictably used.

Candidate for upfront availability or promotion.

## WARM

Useful and searchable, but not normally loaded into the initial model context.

## COLD

Rarely used, recently installed, or low-confidence capabilities.

Search/on-demand only.

Example:

```text
HOT
  github.get_my_prs
  github.get_pull_request
  jira.get_issue
  slack.search

WARM
  github.create_issue
  jira.update_issue
  github.create_release

COLD
  figma.export_pdf
  aws.rare_operation
```

Important: **usage frequency alone must not determine HOT status.**

The ranking engine should consider:

- global frequency
- user-specific frequency
- project-specific frequency
- recency
- current conversation/task relevance
- success rate
- context cost
- latency
- explicit user pinning
- explicit exclusions

---

# 11. Prediction / Prefetching

Nexus should eventually learn tool sequences.

Example learned sequence:

```text
get_pull_request
    -> get_pull_request_diff
    -> list_review_comments
    -> get_jira_issue
```

When the agent selects `get_pull_request`, Nexus can raise the ranking of likely next capabilities.

This is analogous to request prefetching in traditional systems.

## Important rule

Prediction must not automatically execute tools.

Prediction may:

- preload a schema
- preload a connection
- increase ranking
- keep a server warm

Prediction must not silently perform side-effecting downstream operations.

---

# 12. Configuration

The user should not need to place every MCP definition directly in the AI harness configuration.

The harness should only configure MCP Nexus.

Example harness configuration concept:

```json
{
  "mcpServers": {
    "mcp-nexus": {
      "command": "mcp-nexus",
      "args": ["--config", "./project-mcp.json"]
    }
  }
}
```

The actual downstream servers live in a separate Nexus configuration file.

Suggested filename:

```text
project-mcp.json
```

or:

```text
nexus.mcp.json
```

The CLI must support an arbitrary path:

```bash
mcp-nexus --config /path/to/my-mcps.json
```

## Example Nexus config

```json
{
  "version": 1,
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@example/github-mcp"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      },
      "tags": ["development", "github", "code-review"]
    },
    "jira": {
      "command": "npx",
      "args": ["-y", "@example/jira-mcp"],
      "env": {
        "JIRA_URL": "${JIRA_URL}",
        "JIRA_TOKEN": "${JIRA_TOKEN}"
      },
      "tags": ["jira", "project-management", "tickets"]
    }
  },
  "routing": {
    "strategy": "adaptive",
    "semanticSearch": true,
    "prefetch": true
  },
  "analytics": {
    "enabled": true,
    "storage": "local"
  }
}
```

Secrets should be referenced through environment variables or supported secret managers rather than persisted as plaintext where possible.

---

# 13. Project vs Global Configuration

Support these locations:

```text
Global:
~/.config/mcp-nexus/config.json

Project:
./project-mcp.json
```

Recommended resolution order:

```text
built-in defaults
   ↓
global config
   ↓
project config
   ↓
CLI overrides
```

Project config should be able to:

- add servers
- disable servers
- override routing settings
- pin tools
- block tools
- configure analytics retention

---

# 14. Local Data Storage

Use SQLite for v1.

Suggested location:

```text
.mcp-nexus/
    nexus.db
    cache/
    embeddings/
    logs/
```

Do not require a separate database server.

## Suggested SQLite tables

### `servers`

```text
id
name
config_hash
transport
status
created_at
updated_at
last_started_at
last_connected_at
```

### `capabilities`

```text
id
server_id
tool_name
title
description
metadata_json
schema_hash
risk_level
embedding_ref
created_at
updated_at
```

### `usage_events`

```text
id
timestamp
session_id
server_id
capability_id
event_type
latency_ms
success
source
```

### `routing_stats`

```text
capability_id
user_scope
project_scope
usage_count
success_rate
avg_latency_ms
last_used_at
prediction_score
updated_at
```

### `tool_sequences`

```text
previous_capability_id
next_capability_id
occurrences
probability
updated_at
```

---

# 15. MCP Lifecycle Manager

Nexus should support lazy lifecycle management.

States:

```text
REGISTERED
    ↓
DISCOVERED
    ↓
STOPPED / NOT_STARTED
    ↓
STARTING
    ↓
RUNNING
    ↓
IDLE
    ↓
STOPPED
```

A downstream MCP should only be started when required, unless:

- user explicitly pins it
- it is configured as always-on
- prediction indicates high likelihood of immediate use
- the server is needed for indexing and supports safe metadata discovery

## Warm connection strategy

Frequently used MCPs should remain running for a configurable idle timeout.

Example:

```text
hotIdleTimeout: 15m
warmIdleTimeout: 5m
coldIdleTimeout: 1m
```

These are examples, not fixed requirements.

---

# 16. Indexing Lifecycle

At startup:

```text
Load config
   ↓
Load local database
   ↓
Validate server definitions
   ↓
Check index health
   ↓
Refresh stale metadata only
   ↓
Start MCPs required for indexing
   ↓
Update capability metadata
   ↓
Ready
```

Do not start every MCP just because Nexus starts.

Where possible, the index should persist previously discovered metadata and refresh lazily.

---

# 17. Routing Flow

Example user request:

> "Find comments people left on my PR."

Flow:

```text
AI Agent
   |
   | search_capabilities(
   |   "comments people left on my PR"
   | )
   v
MCP Nexus
   |
   +-- exact search
   +-- lexical search
   +-- semantic search
   +-- adaptive ranking
   |
   v
Top candidates
   |
   +-- github.pull_requests.comments.list
   +-- github.pull_requests.reviews.list
   |
   v
Agent selects capability
   |
   | describe_capabilities(...)
   v
Full schema returned
   |
   | execute_capability(...)
   v
MCP Nexus
   |
   v
GitHub MCP
   |
   v
GitHub API
   |
   v
Result
   |
   v
AI Agent
```

---

# 18. Direct Keyword Discovery

The agent should be able to pass keywords without natural-language phrasing.

Examples:

```text
"github pr comments"
"jira ticket assignee"
"figma comments"
"slack search messages"
```

Search should normalize:

- casing
- punctuation
- common abbreviations
- aliases
- synonyms

Example aliases:

```text
PR -> pull request
MR -> merge request
ticket -> issue
repo -> repository
msg -> message
```

The alias system should be configurable.

---

# 19. Explicit User Controls

Users need control over the adaptive router.

Support:

```text
pin server
pin capability
disable server
disable capability
mark capability preferred
mark capability hidden
reset analytics
rebuild index
```

Example config:

```json
{
  "routing": {
    "pinnedCapabilities": [
      "github.pull_requests.get",
      "jira.issues.get"
    ],
    "disabledCapabilities": [
      "github.repository.delete"
    ]
  }
}
```

Pinned capabilities should outrank learned popularity.

Explicit deny/block rules must override all routing logic.

---

# 20. Safety / Permissions

MCP Nexus is a routing layer, not a trust boundary by itself.

However, it should enforce local routing controls.

Every capability should have an optional risk classification:

```text
read
write
destructive
unknown
```

Potential future policy engine:

```json
{
  "policies": {
    "destructive": "ask",
    "write": "allow",
    "unknown": "deny"
  }
}
```

Nexus must not automatically execute a tool merely because it predicts that it is likely to be useful.

---

# 21. Analytics Privacy Model

Default behavior:

- no cloud telemetry
- no user account required
- no remote analytics service
- data stays on the local machine

Store only what is needed for routing and observability.

Do not persist raw tool arguments by default.

Provide analytics commands:

```bash
mcp-nexus analytics summary
mcp-nexus analytics tools
mcp-nexus analytics searches
mcp-nexus analytics predictions
mcp-nexus analytics reset
```

Example summary:

```text
MCP Nexus Analytics

Servers: 14
Indexed capabilities: 428
Calls: 1,842
Successful: 98.4%
Discovery searches: 611
Search → execution: 86.2%
Predicted tool usage: 34.7%
Prediction accuracy: 79.1%
Estimated schema-load reduction: 91%
```

The last metric is an estimate and must be clearly labeled as such.

---

# 22. CLI

Proposed commands:

```bash
mcp-nexus init
mcp-nexus add <server>
mcp-nexus remove <server>
mcp-nexus list
mcp-nexus status
mcp-nexus doctor
mcp-nexus index
mcp-nexus search <query>
mcp-nexus analytics summary
mcp-nexus analytics tools
mcp-nexus analytics reset
mcp-nexus config path
mcp-nexus logs
```

Example setup:

```bash
npx mcp-nexus init
```

Then:

```bash
npx mcp-nexus add github
```

or edit `project-mcp.json` manually.

The actual MCP Nexus runtime should be usable through a single command from any supported harness.

---

# 23. Developer Experience

A new user should be able to go from zero to working MCP routing in roughly these steps:

```text
1. Install mcp-nexus
2. Create project-mcp.json
3. Add downstream MCPs
4. Configure MCP Nexus in the harness
5. Start using MCP capabilities
```

The user should not need to understand embeddings, SQLite, ranking, indexes, or lifecycle management.

Advanced features should be opt-in.

---

# 24. Error Handling

Nexus should return structured, useful errors.

Examples:

```text
MCP_NOT_FOUND
MCP_START_FAILED
MCP_CONNECTION_FAILED
CAPABILITY_NOT_FOUND
CAPABILITY_AMBIGUOUS
CAPABILITY_SCHEMA_UNAVAILABLE
TOOL_EXECUTION_FAILED
PERMISSION_DENIED
TIMEOUT
INDEX_STALE
```

If several capabilities are similarly ranked, return enough metadata for the agent to choose safely.

Example:

```json
{
  "status": "ambiguous",
  "results": [
    {
      "capabilityId": "jira.issues.search",
      "score": 0.81
    },
    {
      "capabilityId": "linear.issues.search",
      "score": 0.79
    }
  ]
}
```

---

# 25. Performance Requirements

Targets for v1:

- Local capability lookup: <50ms p95 without embedding computation.
- Cached semantic lookup: <150ms p95.
- No unnecessary MCP startup for unrelated queries.
- Index should support thousands of capabilities without requiring a remote service.
- Startup should not block on every configured MCP.
- Search should remain useful with hundreds of MCP servers and thousands of tools.

Performance should be measured with realistic datasets rather than toy examples.

---

# 26. Recommended Technology Stack

The implementation can be TypeScript/Node.js because MCP ecosystem integration and CLI distribution are strong fits for this stack.

Suggested components:

```text
Runtime:         Node.js + TypeScript
MCP layer:       MCP SDK
CLI:             Node.js CLI
Storage:         SQLite
Search:          SQLite FTS5 / BM25
Semantic search: pluggable local embedding provider
Vector storage:  SQLite-compatible vector extension or local vector index
Validation:      Zod or equivalent
Logging:         structured local logger
Testing:         Vitest + integration tests
```

Do not hard-code one embedding provider into the routing abstraction.

Create an interface:

```ts
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}
```

Possible implementations later:

- local embedding model
- ONNX runtime
- platform-native embedding API
- optional remote provider configured by the user

The product remains local-first even if an optional remote provider is used for embeddings.

---

# 27. Core Internal Modules

Recommended package structure:

```text
src/
  cli/
  mcp/
    server.ts
    client.ts
    transport.ts
  registry/
  index/
    metadata.ts
    lexical.ts
    semantic.ts
  router/
    search.ts
    ranker.ts
    predictor.ts
    policies.ts
  lifecycle/
  analytics/
  storage/
  config/
  cache/
  telemetry/
  models/
  utils/
```

Keep interfaces between modules explicit.

---

# 28. Key Interfaces

## MCP Registry

```ts
interface MCPRegistry {
  register(server: MCPServerDefinition): Promise<void>;
  remove(serverId: string): Promise<void>;
  list(): Promise<MCPServerDefinition[]>;
  get(serverId: string): Promise<MCPServerDefinition | undefined>;
}
```

## Capability Index

```ts
interface CapabilityIndex {
  index(serverId: string): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<CapabilityMatch[]>;
  get(capabilityId: string): Promise<Capability | undefined>;
  rebuild(): Promise<void>;
}
```

## Router

```ts
interface CapabilityRouter {
  search(query: string, context?: RoutingContext): Promise<CapabilityMatch[]>;
  describe(ids: string[]): Promise<Capability[]>;
  execute(id: string, args: unknown, context?: ExecutionContext): Promise<unknown>;
}
```

## Lifecycle manager

```ts
interface MCPLifecycleManager {
  ensureStarted(serverId: string): Promise<void>;
  stop(serverId: string): Promise<void>;
  status(serverId: string): Promise<ServerStatus>;
}
```

## Analytics

```ts
interface AnalyticsStore {
  record(event: AnalyticsEvent): Promise<void>;
  getToolStats(options?: StatsOptions): Promise<ToolStats[]>;
  getSequenceStats(): Promise<SequenceStats[]>;
  reset(scope?: ResetScope): Promise<void>;
}
```

---

# 29. Adaptive Ranking Engine

The ranking system must be deterministic enough to debug.

Every result should have an explanation internally.

Example:

```json
{
  "capabilityId": "github.pull_requests.get",
  "score": 0.94,
  "signals": {
    "semantic": 0.91,
    "lexical": 0.88,
    "userAffinity": 0.97,
    "recentUsage": 0.82,
    "globalUsage": 0.71,
    "successRate": 0.99
  }
}
```

This will make the system much easier to tune.

Do not start with a neural routing model.

Start with transparent scoring.

A learned model can be added later after enough local data exists.

---

# 30. Search Quality Evaluation

Create a benchmark dataset with queries and expected capabilities.

Examples:

```text
"show my PRs"
=> github.pull_requests.list

"who commented on my pull request"
=> github.pull_requests.comments.list

'ticket assigned to me'
=> jira.issues.search

"find messages about deployment"
=> slack.messages.search
```

Track:

- Recall@K
- Precision@K
- MRR
- search-to-execution conversion
- ambiguous-result rate
- average number of discovery calls

The routing engine should improve without making obvious matches worse.

---

# 31. Context Reduction Measurement

This is a key product metric.

Measure at least:

```text
Total downstream tools available
Tools initially exposed
Tools discovered per task
Schemas loaded per task
Discovery calls per task
Execution calls per task
Estimated tokens before Nexus
Estimated tokens with Nexus
```

Example:

```text
Without Nexus

12 MCPs
416 tools
~72k tool-schema tokens

With Nexus

12 MCPs
9 control tools / capabilities
~3k initial tokens
5 schemas loaded for task
```

The exact token numbers must come from measurement, not marketing claims.

---

# 32. Extensibility

MCP Nexus should be plugin-oriented internally.

Pluggable interfaces:

```text
Search provider
Embedding provider
Ranking strategy
Storage provider
Analytics sink
Policy engine
Lifecycle strategy
```

A future user should be able to replace components without modifying core routing logic.

---

# 33. Import / Compatibility Strategy

The product should make adopting Nexus easy.

Support importing a standard MCP server configuration where possible.

Potential commands:

```bash
mcp-nexus import ./mcp.json
mcp-nexus import --from claude
mcp-nexus import --from cursor
```

The importer should translate existing MCP configurations into `project-mcp.json` rather than requiring users to manually recreate them.

Do not assume every harness uses the same format; implement adapters where practical.

---

# 34. Observability

A local diagnostics command should show:

```text
Nexus Status

Config:      ./project-mcp.json
Database:    ./.mcp-nexus/nexus.db
Servers:     14
Running:     3
Indexed:     412 capabilities
Embeddings:  412

HOT:         18
WARM:        127
COLD:        267

Last search: 1.2s ago
Last tool:   github.pull_requests.get
```

For debugging:

```bash
mcp-nexus logs --routing
```

Should show:

```text
Query: "review my PR"

Candidates:
  github.pull_requests.get       0.95
  github.pull_requests.reviews   0.93
  jira.issues.get                0.61

Selected:
  github.pull_requests.get

Reason:
  semantic=.92 lexical=.87 user=.98 recent=.91
```

This transparency is critical because routing systems are otherwise difficult to trust.

---

# 35. Security Requirements

1. Never expose downstream credentials through capability metadata.
2. Never return environment variables through search results.
3. Sanitize logs.
4. Do not persist raw tool arguments unless explicitly enabled.
5. Respect downstream MCP authentication mechanisms.
6. Validate capability IDs before execution.
7. Prevent path traversal in config references.
8. Restrict external URLs/process execution according to user configuration.
9. Treat imported MCP configurations as potentially untrusted.
10. Never auto-execute predicted capabilities.

---

# 36. Failure Modes

### Downstream MCP unavailable

Search should still return indexed metadata if the index is available, but execution should produce a clear availability error.

### Index stale

Mark result metadata as stale and refresh lazily.

### Search returns no result

Return a useful message and optionally suggest broader keywords or server-level search.

### MCP startup fails

Return the downstream startup error without leaking secrets.

### Semantic embedding provider unavailable

Fallback to lexical/exact search.

### Database unavailable/corrupt

Fallback should be possible for basic direct execution if configured, and provide a repair command where feasible.

---

# 37. Versioning

Config format must include:

```json
{
  "version": 1
}
```

Capability IDs should remain stable across index rebuilds as much as possible.

Database migrations must be versioned.

Do not require users to delete their local analytics/index database on every upgrade.

---

# 38. MVP Definition

The MVP is complete when all of the following work:

### Configuration

- One Nexus MCP can be configured in the harness.
- Multiple downstream MCP servers can be defined in a separate config file.
- Environment variable substitution works.

### Registry

- Add/list/remove servers.
- Validate config.

### MCP client management

- Connect to stdio-based MCP servers.
- Discover tools.
- Start MCPs on demand.
- Execute downstream tools.

### Index

- Persist tool metadata.
- Exact/keyword search.
- BM25/FTS search.

### Agent API

- `search_capabilities`
- `describe_capabilities`
- `execute_capability`

### Analytics

- Local event recording.
- Per-tool usage counts.
- Recent usage.
- success/failure rates.
- Simple adaptive ranking.

### CLI

- init
- list
- add/remove
- status
- search
- analytics
- doctor

### Reliability

- Clear errors.
- Timeouts.
- Process cleanup.
- Local logging.

---

# 39. Phase 2

After MVP:

- semantic embeddings
- hybrid search
- HOT/WARM/COLD classification
- user/project-specific ranking
- tool sequence prediction
- schema prefetching
- connection prewarming
- configurable routing weights
- dynamic tool promotion
- richer analytics dashboard

---

# 40. Phase 3

Potential advanced features:

- learned routing model
- automatic aliases/synonyms
- per-project routing profiles
- capability groups
- policy engine
- MCP dependency graph
- health scoring
- automatic server quarantine after repeated failures
- interactive local UI
- importers for more AI harnesses
- benchmark tooling for context reduction

---

# 41. User Experience Example

## Setup

User creates:

```text
project-mcp.json
```

with:

```text
GitHub
Jira
Slack
Figma
Notion
AWS
```

The harness only has:

```text
mcp-nexus
```

## First request

User:

> "Find my open PRs."

Nexus:

```text
semantic search
   ↓
github.pull_requests.list
   ↓
start GitHub MCP
   ↓
load schema
   ↓
execute
```

## Later request

User:

> "Show my PRs."

Analytics already knows:

```text
"my PRs" → github.pull_requests.list
```

So Nexus can rank the capability immediately and avoid unnecessary broad searching.

## More complex request

User:

> "Check my PR against the Jira acceptance criteria and tell me what is missing."

Nexus discovers:

```text
GitHub:
  get PR
  get diff

Jira:
  get issue
  get acceptance criteria
```

Only relevant capabilities are loaded/executed.

---

# 42. What Makes MCP Nexus Valuable

The product is not simply:

```text
"Run multiple MCP servers."
```

The value proposition is:

```text
Many MCPs
    ↓
One MCP endpoint
    ↓
Indexed capabilities
    ↓
Semantic discovery
    ↓
Adaptive routing
    ↓
Only relevant schemas/capabilities
    ↓
Lower context overhead
    ↓
Better scalability
```

The adaptive analytics layer adds:

```text
Usage history
    ↓
Better ranking
    ↓
Better predictions
    ↓
Less discovery overhead
    ↓
Faster repeated tasks
```

---

# 43. Product Principles

1. **Local-first.** User data stays on the user's machine by default.
2. **One connection.** The harness should need only one Nexus MCP configuration.
3. **Discover, don't dump.** Never expose hundreds of tool schemas unnecessarily.
4. **Metadata before schemas.** Large schemas are loaded only when needed.
5. **Adaptive, not blindly popular.** Usage is a signal, not the entire routing decision.
6. **Predict, don't execute.** Prediction can prefetch; it cannot silently perform side effects.
7. **Transparent routing.** Every routing decision should be explainable.
8. **Composable architecture.** Search, ranking, storage, embeddings, and lifecycle management should be replaceable.
9. **Existing MCPs should just work.** Minimize requirements for downstream servers.
10. **Harness agnostic.** Don't couple the architecture to one AI client.

---

# 44. Recommended Initial Implementation Order

## Step 1
Build config loader + validation.

## Step 2
Build downstream MCP client manager.

## Step 3
Build Nexus MCP server exposing:

```text
search_capabilities
describe_capabilities
execute_capability
```

## Step 4
Build persistent capability registry/index.

## Step 5
Add exact + lexical/BM25 search.

## Step 6
Add lazy lifecycle management.

## Step 7
Add local analytics/event store.

## Step 8
Add adaptive ranking using usage signals.

## Step 9
Add semantic embeddings.

## Step 10
Add hot/warm/cold classification and prefetching.

## Step 11
Add sequence prediction.

## Step 12
Add dynamic tool promotion as an optional advanced mode.

---

# 45. Acceptance Criteria

The first production-quality release should satisfy these scenarios.

### Scenario A — many MCPs, one harness connection

Given 20 configured MCP servers, the harness sees only MCP Nexus.

### Scenario B — relevant capability discovery

Given a natural language request, Nexus returns relevant capabilities without loading every downstream schema into the agent context.

### Scenario C — lazy server startup

A server that is not needed should not start merely because Nexus started.

### Scenario D — execution routing

When the agent selects a capability, Nexus starts/connects to the appropriate MCP and invokes the correct downstream tool.

### Scenario E — local analytics

Tool usage statistics are persisted locally and survive process restarts.

### Scenario F — adaptive ranking

Repeated usage of a capability improves its ranking for future relevant queries.

### Scenario G — explicit overrides

A pinned capability outranks learned popularity, and a blocked capability is never selected automatically.

### Scenario H — fallback

If semantic search is unavailable, exact and lexical search continue working.

### Scenario I — privacy

No cloud service is required for routing or analytics.

### Scenario J — reproducibility

Deleting `.mcp-nexus` should remove learned analytics/index state without modifying the user's source MCP configuration.

---

# 46. Final Product Definition

**MCP Nexus is a local MCP capability router and adaptive discovery layer.**

It allows an AI harness to connect to a large MCP ecosystem through one MCP endpoint, while MCP Nexus locally manages server configuration, capability indexing, semantic search, lifecycle, routing, and analytics.

The system should optimize for this progression:

```text
First use:
Search → load → execute

Repeated use:
Predict → load → execute

Highly frequent use:
Keep warm / expose early → execute
```

The end state is an MCP ecosystem where the number of installed MCP servers can grow substantially without forcing the AI model to carry every server's full tool surface in every interaction.

---

# 47. Instructions to the Building AI

When implementing MCP Nexus:

1. Treat this document as the product/architecture contract.
2. Prefer simple deterministic mechanisms before introducing ML.
3. Keep the core runtime local-first.
4. Do not add a mandatory cloud dependency.
5. Keep all major subsystems behind interfaces.
6. Build the MVP end-to-end before adding advanced ranking.
7. Include unit tests for ranking and routing.
8. Include integration tests with mock MCP servers.
9. Include failure tests for startup, timeout, malformed configuration, and unavailable servers.
10. Include benchmarks for search latency and context/tool-count reduction.
11. Never hide routing behavior from the developer; provide diagnostics.
12. Preserve backward compatibility for configuration and local database migrations.
13. Do not implement silent side-effecting prefetch execution.
14. Keep user secrets out of logs, indexes, and analytics.
15. Make the downstream MCP transport layer replaceable.

The first implementation target should be a working local CLI + MCP server that can manage at least multiple stdio-based downstream MCP servers, discover their tools, index them, search them, start them lazily, and execute a selected capability through one Nexus MCP connection.
