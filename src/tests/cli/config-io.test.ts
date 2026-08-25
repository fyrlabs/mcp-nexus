import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_KEEP,
  backupDirFor,
  listConfigBackups,
  readConfigFile,
  writeConfigFile,
} from "../../cli/config-io.js";
import { globalConfigPath } from "../../config/paths.js";
import type { NexusConfigFile } from "../../config/schema.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "nexus-config-io-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function configWith(id: string): NexusConfigFile {
  return { version: 1, servers: { [id]: { command: "echo" } } } as NexusConfigFile;
}

describe("cli/config-io backups", () => {
  it("keeps a snapshot per write and prunes to BACKUP_KEEP", () => {
    withTempDir((dir) => {
      const path = join(dir, "project-mcp.json");
      for (let i = 0; i < BACKUP_KEEP + 5; i++) writeConfigFile(path, configWith(`s${i}`));

      const backups = listConfigBackups(path);
      expect(backups).toHaveLength(BACKUP_KEEP);
      expect(new Set(backups.map((backup) => backup.id)).size).toBe(BACKUP_KEEP);
      expect(readdirSync(backupDirFor(path))).toHaveLength(BACKUP_KEEP);
    });
  });

  it("never overwrites a snapshot when writes land in the same millisecond", () => {
    withTempDir((dir) => {
      const path = join(dir, "project-mcp.json");
      for (let i = 0; i < 6; i++) writeConfigFile(path, configWith(`s${i}`));

      // Six writes, the first with nothing to back up, so five distinct snapshots.
      const backups = listConfigBackups(path);
      expect(backups).toHaveLength(5);
      expect(new Set(backups.map((backup) => backup.id)).size).toBe(5);
    });
  });

  it("orders snapshots newest first and round-trips the previous contents", () => {
    withTempDir((dir) => {
      const path = join(dir, "project-mcp.json");
      writeConfigFile(path, configWith("first"));
      writeConfigFile(path, configWith("second"));

      const [newest] = listConfigBackups(path);
      if (!newest) throw new Error("expected a snapshot");
      expect(Object.keys(readConfigFile(newest.path).servers ?? {})).toEqual(["first"]);
      expect(Object.keys(readConfigFile(path).servers ?? {})).toEqual(["second"]);
    });
  });

  it("writes atomically, leaving no temp file behind", () => {
    withTempDir((dir) => {
      const path = join(dir, "project-mcp.json");
      writeConfigFile(path, configWith("alpha"));

      expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
      expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
    });
  });

  it("does not treat unrelated files in the backup dir as snapshots", () => {
    withTempDir((dir) => {
      const path = join(dir, "project-mcp.json");
      writeConfigFile(path, configWith("alpha"));
      writeConfigFile(path, configWith("beta"));
      writeFileSync(join(backupDirFor(path), "notes.txt"), "ignore me", "utf8");
      writeFileSync(join(backupDirFor(path), "other-config.json.2026-01-01.json"), "{}", "utf8");

      const backups = listConfigBackups(path);
      expect(backups).toHaveLength(1);
      expect(backups[0]?.path).toContain("project-mcp.json.");
    });
  });

  it("puts global-config snapshots beside the global config, not in a project dir", () => {
    const globalDir = backupDirFor(globalConfigPath());
    expect(globalDir.endsWith(join("mcp-nexus", "backups"))).toBe(true);
    expect(backupDirFor("/tmp/proj/project-mcp.json")).toBe(
      join("/tmp/proj", ".mcp-nexus", "config-backups"),
    );
  });
});
