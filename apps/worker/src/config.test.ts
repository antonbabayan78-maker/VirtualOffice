import { describe, expect, it } from "vitest";
import { isErr, isOk, unwrap } from "@vo/core";
import { readWorkerConfig } from "./config.js";

const complete = {
  VO_API_URL: "http://localhost:3100",
  VO_API_TOKEN: "sk-owner",
  VO_OFFICE_ID: "office-1",
  ANTHROPIC_API_KEY: "sk-ant-test",
};

describe("telling a worker which office to work for", () => {
  it("reads the office, the address and the token it was given", () => {
    const config = unwrap(readWorkerConfig(complete));
    expect(config).toMatchObject({
      baseUrl: "http://localhost:3100",
      token: "sk-owner",
      officeId: "office-1",
    });
  });

  it("will not start without an address, since it would have nothing to talk to", () => {
    const result = readWorkerConfig({ ...complete, VO_API_URL: undefined });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.path).toBe("VO_API_URL");
  });

  it("will not start without a token, rather than making unauthenticated calls", () => {
    expect(isErr(readWorkerConfig({ ...complete, VO_API_TOKEN: "" }))).toBe(true);
  });

  it("will not start without an office, rather than guessing which one", () => {
    expect(isErr(readWorkerConfig({ ...complete, VO_OFFICE_ID: undefined }))).toBe(true);
  });

  it("names everything that is missing at once, not the first thing only", () => {
    const result = readWorkerConfig({});
    if (isErr(result)) {
      expect(result.error.map((e) => e.path)).toEqual([
        "VO_API_URL",
        "VO_API_TOKEN",
        "VO_OFFICE_ID",
      ]);
    } else {
      throw new Error("expected an empty environment to be refused");
    }
  });

  it("drops a trailing slash, so a path is not joined onto a double one", () => {
    const config = unwrap(readWorkerConfig({ ...complete, VO_API_URL: "http://localhost:3100/" }));
    expect(config.baseUrl).toBe("http://localhost:3100");
  });

  it("rehearses when asked, so an office can be exercised without a key", () => {
    const config = unwrap(readWorkerConfig({ ...complete, VO_DRY_RUN: "1" }));
    expect(config.dryRun).toBe(true);
  });

  it("does not rehearse by default", () => {
    expect(unwrap(readWorkerConfig(complete)).dryRun).toBe(false);
  });

  it("starts with no key, because the office may have services of its own", () => {
    // An office whose people are all on a model in its own network needs
    // nothing from Anthropic, and a worker that refused to start for the want
    // of a key it would never use could not serve that office at all.
    const config = unwrap(readWorkerConfig({ ...complete, ANTHROPIC_API_KEY: undefined }));

    expect(config.apiKey).toBeUndefined();
    expect(config.dryRun).toBe(false);
  });

  it("accepts a real run when it has a key", () => {
    expect(isOk(readWorkerConfig(complete))).toBe(true);
  });

  it("takes how fast to tick and how much to take at once from the environment", () => {
    const config = unwrap(
      readWorkerConfig({ ...complete, VO_DRY_RUN: "1", VO_TICK_MS: "250", VO_BATCH_SIZE: "8" }),
    );
    expect(config.tickMs).toBe(250);
    expect(config.batchSize).toBe(8);
  });

  it("ignores a tick interval that is not a number rather than ticking at NaN", () => {
    const config = unwrap(readWorkerConfig({ ...complete, VO_DRY_RUN: "1", VO_TICK_MS: "soon" }));
    expect(config.tickMs).toBeGreaterThan(0);
  });
});
