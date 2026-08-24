import { realpathSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

export interface ConfigWatcher {
  dispose(): void;
}

export function watchConfigFile(
  configPath: string,
  onChange: () => void,
  debounceMs = 300,
): ConfigWatcher {
  // realpath first: libuv's Windows fs-event asserts when the watched directory
  // contains 8.3 short-name segments (e.g. RUNNER~1), crashing the process.
  let directory: string;
  try {
    directory = dirname(realpathSync(configPath));
  } catch {
    directory = dirname(configPath);
  }
  const fileName = basename(configPath);
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  let watcher: FSWatcher;
  try {
    watcher = watch(directory, { persistent: true }, (_event, changedFile) => {
      if (disposed) return;
      if (changedFile !== undefined && changedFile !== fileName) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) onChange();
      }, debounceMs);
    });
  } catch {
    return { dispose: () => { disposed = true; } };
  }

  return {
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
