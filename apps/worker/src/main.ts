#!/usr/bin/env node
/**
 * The worker process. Thin on purpose: it resolves the outside world — the
 * environment, the clock, the signal that stops it, stdout — and hands the rest
 * to code that is tested without any of them.
 */
import { createAnthropicProvider, rehearsalProvider, unavailableProvider } from "@vo/llm";
import { isErr } from "@vo/core";
import { readWorkerConfig } from "./config.js";
import { createOfficeWorker } from "./office-worker.js";
import { runWorkerLoop } from "./index.js";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<number> {
  const config = readWorkerConfig(process.env);
  if (isErr(config)) {
    for (const error of config.error) say(`${error.path}: ${error.message}`);
    return 2;
  }

  const { baseUrl, officeId, dryRun, apiKey, tickMs, batchSize } = config.value;
  /**
   * What a turn falls back to when the employee names no service of the
   * office's own. A rehearsal when asked for one; otherwise the real provider,
   * or — with no key — something that says what is missing when it is actually
   * needed. Not a rehearsal in that case: an office that looked like it was
   * working while calling nothing is worse than one that stops and says why.
   */
  const provider = dryRun
    ? rehearsalProvider()
    : apiKey === undefined
      ? unavailableProvider(
          "anthropic",
          "no model to work with: set ANTHROPIC_API_KEY, give this office a service of its own," +
            " or set VO_DRY_RUN to rehearse",
        )
      : createAnthropicProvider({ apiKey });

  const worker = createOfficeWorker({
    config: config.value,
    provider,
    onProblem: (message) => {
      say(`! ${message}`);
    },
  });

  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      say(`\n${signal}: finishing the current tick and stopping`);
      stop.abort();
    });
  }

  say(`working for ${officeId} at ${baseUrl}${dryRun ? " (rehearsal, no model is called)" : ""}`);

  const summary = await runWorkerLoop({
    worker,
    signal: stop.signal,
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    intervalMs: tickMs,
    batchSize,
    onTick: (report) => {
      // Only say something when something happened: a quiet office should be
      // quiet, or the log is unreadable by the time anything goes wrong.
      if (report.enqueued + report.processed + report.recovered === 0) return;
      const recovered = report.recovered > 0 ? `, recovered ${String(report.recovered)}` : "";
      const failed = report.failed > 0 ? `, failed ${String(report.failed)}` : "";
      say(
        `queued ${String(report.enqueued)}, did ${String(report.processed)}${recovered}${failed}`,
      );
      for (const failure of report.errors) say(`! ${failure.kind}: ${failure.error}`);
    },
    onError: (error) => {
      say(`! tick failed: ${error.message}`);
    },
  });

  say(`stopped after ${String(summary.ticks)} ticks, ${String(summary.processed)} jobs done`);
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
