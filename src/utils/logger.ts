import { redactUnknown } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  stream?: NodeJS.WritableStream;
}

function parseLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error" || normalized === "silent") {
    return normalized;
  }
  return process.env.NODE_ENV === "test" ? "warn" : "info";
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  const stream = options.stream ?? process.stderr;
  const threshold = LEVEL_WEIGHT[options.level ?? parseLevel(process.env.MCP_NEXUS_LOG_LEVEL)];

  function write(level: Exclude<LogLevel, "silent">, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg: message,
    };
    if (data !== undefined) entry.data = redactUnknown(data);
    try {
      stream.write(`${JSON.stringify(entry)}\n`);
    } catch {
      // stderr failures must never break the runtime
    }
  }

  return {
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
    child: (childScope) => createLogger(`${scope}:${childScope}`, { level: options.level, stream }),
  };
}
