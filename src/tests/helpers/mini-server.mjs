import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "mini", version: "0.0.0" });

server.registerTool(
  "echo_thing",
  { description: "Echoes a thing back for CLI smoke tests" },
  async () => ({ content: [{ type: "text", text: "echoed" }] }),
);

server.registerTool(
  "add_numbers",
  { description: "Adds two numbers together for CLI smoke tests" },
  async () => ({ content: [{ type: "text", text: "42" }] }),
);

await server.connect(new StdioServerTransport());
