#!/usr/bin/env node
import { runCli } from "./cli.js";

runCli(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`mcp-nexus: fatal: ${message}\n`);
  process.exit(1);
});
