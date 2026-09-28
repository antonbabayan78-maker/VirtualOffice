import { describe, expect, it } from "vitest";
import { rehearsalProvider } from "@vo/llm";
import { createOfficeWorker } from "./office-worker.js";

const config = {
  baseUrl: "http://office.test",
  token: "sk-owner",
  officeId: "office-1",
  dryRun: true,
  apiKey: undefined,
  tickMs: 10,
  batchSize: 2,
};

describe("putting a worker together", () => {
  it("builds one that can tick", () => {
    const worker = createOfficeWorker({ config, provider: rehearsalProvider() });
    expect(typeof worker.tick).toBe("function");
  });

  it("does nothing at all when the office cannot be reached, and says why", async () => {
    // Nothing is listening on that address, which is the honest version of a
    // server that is down: the tick must survive it.
    const problems: string[] = [];
    const worker = createOfficeWorker({
      config,
      provider: rehearsalProvider(),
      onProblem: (message) => problems.push(message),
    });

    const report = await worker.tick();
    expect(report.enqueued).toBe(0);
    expect(report.failed).toBe(0);
    expect(problems.join(" ")).toMatch(/could not read office/);
  });
});
