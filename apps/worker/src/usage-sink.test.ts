import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@vo/api-client";
import type { UsageEvent } from "@vo/telemetry";
import type { OfficeId, TaskId } from "@vo/core";
import { apiUsageSink } from "./usage-sink.js";

const officeId = "office-acme" as OfficeId;

const event = (overrides: Partial<UsageEvent> = {}): UsageEvent =>
  ({
    id: "ev-1",
    kind: "llm_call",
    at: Date.parse("2026-10-01T09:00:00Z"),
    attribution: { officeId, taskId: "task-1" as TaskId },
    durationMs: 1200,
    ok: true,
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    cost: null,
    streamed: false,
    ...overrides,
  }) as UsageEvent;

const apiThat = (recordUsage: ApiClient["recordUsage"]): ApiClient =>
  ({ recordUsage }) as unknown as ApiClient;

describe("telling the office what a call cost", () => {
  it("sends the event to the office it was spent in", async () => {
    const recordUsage = vi.fn(() => Promise.resolve({ ok: true as const, value: {} as never }));
    await apiUsageSink(apiThat(recordUsage)).record(event());

    expect(recordUsage).toHaveBeenCalledWith(officeId, expect.objectContaining({ id: "ev-1" }));
  });

  it("sends each call as it happens, rather than holding them", async () => {
    // A worker that dies loses whatever it was holding; a turn makes a handful
    // of calls, not thousands, so there is nothing to batch away yet.
    const recordUsage = vi.fn(() => Promise.resolve({ ok: true as const, value: {} as never }));
    const sink = apiUsageSink(apiThat(recordUsage));
    await sink.record(event({ id: "ev-1" }));
    await sink.record(event({ id: "ev-2" }));

    expect(recordUsage).toHaveBeenCalledTimes(2);
  });
});

describe("an office that cannot be told", () => {
  it("does not fail the work it was measuring", async () => {
    // The whole promise of this layer: metering never fails the call it
    // measures. A sink that threw would turn a flaky network into failed work.
    const sink = apiUsageSink(
      apiThat(() =>
        Promise.resolve({ ok: false as const, kind: "transport" as const, message: "offline" }),
      ),
    );

    await expect(sink.record(event())).resolves.toBeUndefined();
  });

  it("does not fail when the office refuses the event either", async () => {
    const sink = apiUsageSink(
      apiThat(() =>
        Promise.resolve({
          ok: false as const,
          kind: "validation" as const,
          errors: [{ path: "at", message: "must be epoch milliseconds" }],
        }),
      ),
    );

    await expect(sink.record(event())).resolves.toBeUndefined();
  });

  it("does not fail when the call itself throws", async () => {
    const sink = apiUsageSink(apiThat(() => Promise.reject(new Error("socket hang up"))));
    await expect(sink.record(event())).resolves.toBeUndefined();
  });

  it("says what was lost, rather than losing it silently", async () => {
    const problems: string[] = [];
    const sink = apiUsageSink(
      apiThat(() =>
        Promise.resolve({ ok: false as const, kind: "transport" as const, message: "offline" }),
      ),
      (message) => problems.push(message),
    );

    await sink.record(event());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/usage|offline/i);
  });

  it("says which office and which call, so the gap can be found", async () => {
    const problems: string[] = [];
    const sink = apiUsageSink(
      apiThat(() => Promise.reject(new Error("socket hang up"))),
      (message) => problems.push(message),
    );

    await sink.record(event());
    expect(problems[0]).toContain("ev-1");
  });
});
