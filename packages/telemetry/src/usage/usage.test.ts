import { describe, expect, it, vi } from "vitest";
import {
  FakeLlmProvider,
  LlmProviderError,
  defaultModelRegistry,
  reply,
  type CompletionRequest,
  type Usage,
} from "@vo/llm";
import type { DepartmentId, EmployeeId, OfficeId, TaskId } from "@vo/core";
import {
  InMemoryUsageSink,
  UsageRecorder,
  meterProvider,
  meterToolCall,
  type UsageAttribution,
  type UsageEvent,
} from "./usage.js";

const office = "office-acme" as OfficeId;
const attribution: UsageAttribution = {
  officeId: office,
  departmentId: "dept-eng" as DepartmentId,
  employeeId: "emp-ada" as EmployeeId,
  taskId: "task-1" as TaskId,
  runId: "run-7",
};

const registry = defaultModelRegistry();
const model = "claude-sonnet-5";
const ref = { provider: "anthropic", model };
const request = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  ...overrides,
});

function setup(): { sink: InMemoryUsageSink; recorder: UsageRecorder; ids: () => string[] } {
  const sink = new InMemoryUsageSink();
  let seq = 0;
  let clock = 1_700_000_000_000;
  const recorder = new UsageRecorder({
    sink,
    registry,
    now: () => (clock += 10),
    id: () => `event-${String(++seq)}`,
  });
  return { sink, recorder, ids: () => sink.events.map((e) => e.id) };
}

const llmEvents = (events: readonly UsageEvent[]) => events.filter((e) => e.kind === "llm_call");

describe("metering an LLM provider", () => {
  it("records exactly one event per call", async () => {
    const { sink, recorder } = setup();
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => reply("ok") }),
      { recorder, attribution },
    );

    await metered.complete(request());
    await metered.complete(request());
    await metered.complete(request());

    expect(sink.events).toHaveLength(3);
    expect(sink.events.every((e) => e.kind === "llm_call")).toBe(true);
  });

  it("gives each event its own id", async () => {
    const { sink, recorder } = setup();
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => reply("ok") }),
      {
        recorder,
        attribution,
      },
    );
    await metered.complete(request());
    await metered.complete(request());
    expect(new Set(sink.events.map((e) => e.id)).size).toBe(2);
  });

  it("carries the attribution the dashboard groups by", async () => {
    const { sink, recorder } = setup();
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => reply("ok") }),
      {
        recorder,
        attribution,
      },
    );
    await metered.complete(request());
    expect(sink.events[0]?.attribution).toEqual(attribution);
    const event = llmEvents(sink.events)[0];
    expect(event?.model).toBe(model);
    expect(event?.provider).toBe("anthropic");
  });

  it("asks for the attribution per call, so one provider can serve many employees", async () => {
    const { sink, recorder } = setup();
    let employee = "emp-ada" as EmployeeId;
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => reply("ok") }),
      {
        recorder,
        attribution: () => ({ officeId: office, employeeId: employee }),
      },
    );
    await metered.complete(request());
    employee = "emp-bob" as EmployeeId;
    await metered.complete(request());
    expect(sink.events.map((e) => e.attribution.employeeId)).toEqual(["emp-ada", "emp-bob"]);
  });

  it("costs the call exactly as the model registry does", async () => {
    const { sink, recorder } = setup();
    const usage: Usage = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadInputTokens: 2_000,
      cacheCreationInputTokens: 100,
    };
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => ({ ...reply("ok"), usage }) }),
      { recorder, attribution },
    );
    await metered.complete(request());

    const expected = registry.costOf(ref, usage);
    const event = llmEvents(sink.events)[0];
    expect(event?.cost).toEqual(expected);
    expect(event?.cost?.totalUsd).toBeGreaterThan(0);
  });

  it("keeps cached tokens and their cost apart from fresh input", async () => {
    const { sink, recorder } = setup();
    const usage: Usage = {
      inputTokens: 10,
      outputTokens: 10,
      cacheReadInputTokens: 50_000,
      cacheCreationInputTokens: 1_000,
    };
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => ({ ...reply("ok"), usage }) }),
      { recorder, attribution },
    );
    await metered.complete(request());

    const event = llmEvents(sink.events)[0];
    expect(event?.usage.cacheReadInputTokens).toBe(50_000);
    expect(event?.usage.cacheCreationInputTokens).toBe(1_000);
    expect(event?.cost?.cacheReadUsd).toBeGreaterThan(0);
    expect(event?.cost?.cacheWriteUsd).toBeGreaterThan(0);
    // Reading cache is cheaper than sending the same tokens fresh.
    expect(event?.cost?.cacheReadUsd ?? 0).toBeLessThan(
      registry.costOf(ref, { ...usage, inputTokens: 50_000, cacheReadInputTokens: 0 }).inputUsd,
    );
  });

  it("records a call it cannot price without pretending it was free", async () => {
    const { sink, recorder } = setup();
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => reply("ok") }),
      { recorder, attribution },
    );

    // An unknown model must not take the call down, and must not look free.
    await expect(metered.complete(request({ model: "some-new-model" }))).resolves.toBeDefined();
    const event = llmEvents(sink.events)[0];
    expect(event?.cost).toBeNull();
    expect(event?.pricingError).toMatch(/unknown model/);
    expect(event?.usage.outputTokens).toBeGreaterThan(0);
  });

  it("records the call that failed, and lets the failure through", async () => {
    const { sink, recorder } = setup();
    const failing = new FakeLlmProvider({
      id: "anthropic",
      handler: () => {
        throw new LlmProviderError("rate_limited", "slow down");
      },
    });
    const metered = meterProvider(failing, { recorder, attribution });

    await expect(metered.complete(request())).rejects.toThrow(/slow down/);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("slow down") as string,
    });
    expect(llmEvents(sink.events)[0]?.cost?.totalUsd).toBe(0);
  });

  it("times the call", async () => {
    const { sink, recorder } = setup();
    let clock = 5_000;
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => reply("ok") }),
      { recorder, attribution, clock: () => (clock += 25) },
    );
    await metered.complete(request());
    expect(sink.events[0]?.durationMs).toBe(25);
  });
});

describe("metering a streamed call", () => {
  it("records one event, once the stream is finished", async () => {
    const { sink, recorder } = setup();
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => reply("streamed") }),
      {
        recorder,
        attribution,
      },
    );

    const seen: string[] = [];
    for await (const event of metered.stream(request())) {
      // Nothing is recorded until the usage is known, which is at the end.
      if (event.type === "text_delta") {
        seen.push(event.text);
        expect(sink.events).toHaveLength(0);
      }
    }
    expect(seen.join("")).toBe("streamed");
    expect(sink.events).toHaveLength(1);
    expect(llmEvents(sink.events)[0]?.streamed).toBe(true);
    expect(llmEvents(sink.events)[0]?.usage.outputTokens).toBeGreaterThan(0);
  });

  it("still records when the reader walks away mid-stream", async () => {
    const { sink, recorder } = setup();
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => reply("a longer answer") }),
      {
        recorder,
        attribution,
      },
    );

    for await (const event of metered.stream(request())) {
      if (event.type === "text_delta") break;
    }
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.ok).toBe(false);
  });
});

describe("metering a tool call", () => {
  it("records one event and returns what the tool returned", async () => {
    const { sink, recorder } = setup();
    const result = await meterToolCall(recorder, { toolName: "get_diff", attribution }, () =>
      Promise.resolve("a diff"),
    );
    expect(result).toBe("a diff");
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ kind: "tool_call", ok: true });
    if (sink.events[0]?.kind === "tool_call") expect(sink.events[0].toolName).toBe("get_diff");
  });

  it("records a tool that threw, and rethrows it", async () => {
    const { sink, recorder } = setup();
    await expect(
      meterToolCall(recorder, { toolName: "deploy", attribution }, () =>
        Promise.reject(new Error("permission denied")),
      ),
    ).rejects.toThrow(/permission denied/);
    expect(sink.events[0]).toMatchObject({ kind: "tool_call", ok: false });
  });
});

describe("a sink that misbehaves", () => {
  it("never fails the work it is only measuring", async () => {
    const onError = vi.fn((_error: Error) => undefined);
    const recorder = new UsageRecorder({
      sink: { record: () => Promise.reject(new Error("telemetry is down")) },
      registry,
      onError,
    });
    const metered = meterProvider(
      new FakeLlmProvider({ id: "anthropic", handler: () => reply("ok") }),
      {
        recorder,
        attribution,
      },
    );

    const response = await metered.complete(request());
    expect(response.content[0]).toMatchObject({ type: "text" });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("InMemoryUsageSink", () => {
  it("keeps events in the order they happened", async () => {
    const sink = new InMemoryUsageSink();
    const recorder = new UsageRecorder({ sink, registry });
    await meterToolCall(recorder, { toolName: "first", attribution }, () => Promise.resolve(1));
    await meterToolCall(recorder, { toolName: "second", attribution }, () => Promise.resolve(2));
    expect(sink.events.map((e) => (e.kind === "tool_call" ? e.toolName : ""))).toEqual([
      "first",
      "second",
    ]);
  });
});
