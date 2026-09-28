#!/usr/bin/env node
/**
 * The `vo` command. Thin on purpose: it resolves the outside world — argv, the
 * filesystem, stdout, the API key — and hands the rest to code that is tested
 * without any of them.
 */
import { readFile } from "node:fs/promises";
import { runCommand, USAGE } from "./run/run-command.js";
import { createRunProvider } from "./run/provider.js";

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "run") {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined || command === "--help" ? 0 : 2;
  }

  let provider;
  try {
    provider = createRunProvider({
      dryRun: rest.includes("--dry-run"),
      apiKey: process.env["ANTHROPIC_API_KEY"],
    });
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  return runCommand(rest, {
    readFile: (path) => readFile(path, "utf8"),
    write: (line) => process.stdout.write(`${line}\n`),
    provider,
  });
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
