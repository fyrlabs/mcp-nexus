import { createRuntime, type RuntimeOptions } from "../runtime/create-runtime.js";
import { isNexusError } from "../models/errors.js";
import { createLogger } from "../utils/logger.js";
import type { NexusRuntime } from "../runtime/types.js";

export interface CommandContext {
  cwd: string;
  configPath?: string;
  json?: boolean;
}

export async function withRuntime<T>(
  ctx: CommandContext,
  fn: (runtime: NexusRuntime) => Promise<T>,
): Promise<T> {
  const logger = createLogger("nexus");
  const options: RuntimeOptions = {
    cwd: ctx.cwd,
    configPath: ctx.configPath,
    logger,
  };
  const runtime = createRuntime(options);
  await runtime.initialize();
  try {
    return await fn(runtime);
  } finally {
    await runtime.shutdown();
  }
}

export function fail(error: unknown): never {
  if (isNexusError(error)) {
    process.stderr.write(`error [${error.code}]: ${error.message}\n`);
    if (Object.keys(error.details).length > 0) {
      process.stderr.write(`${JSON.stringify(error.details)}\n`);
    }
    process.exit(1);
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
