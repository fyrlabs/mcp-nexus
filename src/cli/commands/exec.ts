import type { Command } from "commander";
import { withRuntime, fail } from "../context.js";

export function registerExec(program: Command): void {
  program
    .command("exec <capabilityId>")
    .description("execute a capability once from the CLI (same routing path the agent control plane uses)")
    .option("-a, --args <json>", "arguments as a JSON object literal", "{}")
    .option("-s, --session <id>", "session id for analytics and sequence learning", "cli")
    .option("--json", "print the raw result as JSON", false)
    .action(async (capabilityId: string, options: { args: string; session: string; json?: boolean }) => {
      const opts = program.opts<{ cwd?: string; config?: string }>();
      try {
        let args: Record<string, unknown>;
        try {
          const parsed = JSON.parse(options.args) as unknown;
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("must be a JSON object");
          }
          args = parsed as Record<string, unknown>;
        } catch (error) {
          throw new Error(`Invalid --args JSON: ${(error as Error).message}`);
        }

        await withRuntime({ cwd: opts.cwd ?? process.cwd(), configPath: opts.config }, async (runtime) => {
          const result = await runtime.execute(capabilityId, args, { sessionId: options.session });
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
          if (Array.isArray(content) && content.length > 0) {
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                console.log(block.text);
              } else {
                console.log(JSON.stringify(block));
              }
            }
            return;
          }
          console.log(JSON.stringify(result, null, 2));
        });
      } catch (error) {
        fail(error);
      }
    });
}
