import { statSync, watchFile, unwatchFile } from "node:fs";

export interface ConfigWatcher {
  dispose(): void;
}

export function watchConfigFile(
  configPath: string,
  onChange: () => void,
  debounceMs = 300,
): ConfigWatcher {
  // Stat polling instead of fs.watch: libuv's Windows fs-event backend has a
  // process-fatal assertion (fs-event.c) triggered by editor rename storms and
  // short-path directories, and polling is immune to both that and network
  // drives. Latency of a few hundred milliseconds is fine for a config file.
  let disposed = false;
  let timer: NodeJS.Timeout | null = null;
  let lastStat = currentStat(configPath);

  watchFile(configPath, { interval: 250 }, () => {
    if (disposed) return;
    const next = currentStat(configPath);
    const changed =
      next === null
        ? lastStat !== null
        : lastStat === null || next.mtimeMs !== lastStat.mtimeMs || next.size !== lastStat.size;
    lastStat = next;
    if (!changed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!disposed) onChange();
    }, debounceMs);
  });

  return {
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      unwatchFile(configPath);
    },
  };
}

function currentStat(path: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}
