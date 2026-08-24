import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchConfigFile } from "../../cli/config-watch.js";

describe("cli/config-watch", () => {
  it("fires onChange when the watched file is rewritten and stops after dispose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-nexus-watch-"));
    const configPath = join(dir, "project-mcp.json");
    writeFileSync(configPath, "{}");

    let changes = 0;
    let notifyChange: () => void = () => undefined;
    const changePromise = new Promise<void>((resolve) => {
      notifyChange = () => {
        changes++;
        resolve();
      };
    });

    const watcher = watchConfigFile(configPath, notifyChange, 50);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(configPath, JSON.stringify({ version: 1 }));
      await changePromise;
      expect(changes).toBe(1);

      watcher.dispose();
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(configPath, JSON.stringify({ version: 1, servers: {} }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(changes).toBe(1);
    } finally {
      watcher.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives dispose being called twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-nexus-watch3-"));
    const configPath = join(dir, "project-mcp.json");
    writeFileSync(configPath, "{}");
    const watcher = watchConfigFile(configPath, () => undefined, 50);
    watcher.dispose();
    expect(() => watcher.dispose()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

});
