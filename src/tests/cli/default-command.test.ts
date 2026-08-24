import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "dist", "cli", "main.js");

interface HandshakeResult {
  serverInfo?: { name: string; version: string };
  tools?: string[];
  error?: string;
}

function handshakeOverStdio(argv: string[], cwd: string, timeoutMs = 15_000): Promise<HandshakeResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0] ?? "node", argv.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let settled = false;
    const finish = (result: HandshakeResult): void => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: `timeout. stderr: ${stderr.slice(0, 300)}` }), timeoutMs);

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        let message: { id?: number; result?: { serverInfo?: { name: string; version?: string } } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          clearTimeout(timer);
          const info = message.result.serverInfo;
          finish({
            serverInfo: info ? { name: info.name, version: info.version ?? "0.0.0" } : undefined,
          });
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ error: String(error) });
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "handshake-test", version: "0.0.0" } } })}\n`,
    );
  });
}

describe("cli: documented launch path", () => {
  it.skipIf(!existsSync(DIST_CLI))(
    "spawning the binary exactly as the README documents performs an MCP handshake",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "mcp-nexus-launch-"));
      writeFileSync(dir + "/project-mcp.json", JSON.stringify({ version: 1, servers: {} }));
      try {
        for (const argv of [
          ["node", DIST_CLI, "--cwd", dir],
          ["node", DIST_CLI, "serve", "--cwd", dir],
        ]) {
          const result = await handshakeOverStdio(argv, dir);
          expect(result.error).toBeUndefined();
          expect(result.serverInfo?.name).toBe("mcp-nexus");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
