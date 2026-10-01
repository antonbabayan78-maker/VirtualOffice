#!/usr/bin/env node
/**
 * The server process. Thin on purpose, like the worker's: it resolves the
 * outside world — the environment, the signal that stops it, stdout — and hands
 * the rest to code that is tested without any of them.
 */
import { isErr } from "@vo/core";
import { readServerConfig } from "./config.js";
import { startServer } from "./start.js";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<number> {
  const config = readServerConfig(process.env);
  if (isErr(config)) {
    for (const error of config.error) say(`${error.path}: ${error.message}`);
    return 2;
  }

  const started = await startServer(config.value, {
    onProblem: (message) => {
      say(`! ${message}`);
    },
  });

  say(`listening on ${started.url}`);
  say(`  records: ${config.value.storage.relational.href}`);
  say(`  documents: ${config.value.storage.blobs.href}`);
  say(
    config.value.allowedOrigins.length === 0
      ? "  browsers: none allowed; set VO_ALLOWED_ORIGINS to serve a canvas"
      : `  browsers: ${config.value.allowedOrigins.join(", ")}`,
  );
  if (config.value.storage.relational.protocol === "memory:") {
    // Said plainly rather than left to be discovered after a restart.
    say("  note: everything is in memory and goes when this process does");
  }

  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        say(`\n${signal}: closing`);
        resolve();
      });
    }
  });

  await started.close();
  say("stopped");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
