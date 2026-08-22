# Harness setup

The harness configures exactly one MCP server: `mcp-nexus`. All downstream servers live in
`project-mcp.json` (see [configuration](configuration.md)).

## Claude Code

```bash
claude mcp add mcp-nexus -- npx -y @fyrlabs/mcp-nexus
```

or in `.mcp.json` / project settings:

```json
{
  "mcpServers": {
    "mcp-nexus": {
      "command": "npx",
      "args": ["-y", "@fyrlabs/mcp-nexus"]
    }
  }
}
```

If your project already has MCP servers configured elsewhere, migrate them instead of
connecting them directly:

```bash
npx @fyrlabs/mcp-nexus import --from claude-code
```

## Claude Desktop

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-nexus": {
      "command": "npx",
      "args": ["-y", "@fyrlabs/mcp-nexus", "--config", "/absolute/path/to/project-mcp.json"]
    }
  }
}
```

Then import what you had before:

```bash
npx @fyrlabs/mcp-nexus import --from claude
```

## Cursor

`~/.cursor/mcp.json` (or project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mcp-nexus": {
      "command": "npx",
      "args": ["-y", "@fyrlabs/mcp-nexus"]
    }
  }
}
```

Existing Cursor entries can be pulled in with `import --from cursor`.

## Generic MCP client / custom install

Any client that launches stdio MCP servers works:

```json
{
  "command": "node",
  "args": ["/path/to/mcp-nexus/dist/cli/main.js", "--config", "./project-mcp.json"]
}
```

Global installs work too: `npm i -g @fyrlabs/mcp-nexus` then `"command": "mcp-nexus"`.

## Verifying

1. `npx @fyrlabs/mcp-nexus doctor` — validates config, env references, and commands.
2. `npx @fyrlabs/mcp-nexus index` — warm the index up front (optional; `serve` does it lazily).
3. Start the harness. You should see four tools:
   `search_capabilities`, `describe_capabilities`, `execute_capability`, `search_servers`.
4. Ask your agent something like *"search capabilities for pull request reviews"* and watch it
   follow the discover → describe → execute flow.

### Tips for agents

Nexus ships instructions on its MCP server telling agents the intended flow. If your harness
supports per-server instructions, keep them enabled — they dramatically improve first-session
behavior. For repeated tasks, analytics-based ranking improves results automatically after a
few sessions; use `analytics summary` to see it working.
