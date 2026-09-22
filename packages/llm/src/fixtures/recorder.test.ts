import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FakeLlmProvider, reply } from "../fake/fake-provider.js";
import type { CompletionRequest } from "../provider/types.js";
import {
  FileFixtureStore,
  fixtureKey,
  InMemoryFixtureStore,
  MissingFixtureError,
  RecordingProvider,
  resolveFixtureMode,
} from "./recorder.js";

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "vo-fixtures-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const request = (text: string, extra: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "claude-sonnet-5",
  system: "sys",
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  ...extra,
});

describe("fixtureKey", () => {
  it("is stable across property order and ignores metadata", () => {
    const a = fixtureKey({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 10,
    });
    const b = fixtureKey({
      maxOutputTokens: 10,
      messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
      system: "s",
      model: "m",
      metadata: { traceId: "x" },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(fixtureKey(request("hi"))).not.toBe(fixtureKey(request("hello")));
  });
});

describe("resolveFixtureMode", () => {
  it("defaults to auto locally, replay in CI, and obeys VO_LLM_FIXTURES", () => {
    expect(resolveFixtureMode({})).toBe("auto");
    expect(resolveFixtureMode({ CI: "true" })).toBe("replay");
    expect(resolveFixtureMode({ CI: "true", VO_LLM_FIXTURES: "record" })).toBe("record");
    expect(resolveFixtureMode({ VO_LLM_FIXTURES: "replay" })).toBe("replay");
    expect(() => resolveFixtureMode({ VO_LLM_FIXTURES: "sometimes" })).toThrow(/VO_LLM_FIXTURES/);
  });
});

describe("RecordingProvider", () => {
  it("records a fixture on first call and replays it without touching the inner provider", async () => {
    const dir = tempDir();
    const inner = new FakeLlmProvider({ script: [reply("recorded answer")] });
    const recording = new RecordingProvider(inner, new FileFixtureStore(dir), { mode: "record" });
    const first = await recording.complete(request("hi"));
    expect(first.content).toEqual([{ type: "text", text: "recorded answer" }]);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const first_file = files[0];
    if (first_file === undefined) throw new Error("no fixture written");
    const fixture = JSON.parse(readFileSync(join(dir, first_file), "utf8")) as {
      key: string;
      request: unknown;
      response: unknown;
    };
    expect(fixture.key).toBe(fixtureKey(request("hi")));
    expect(fixture.response).toEqual(first);

    const replaying = new RecordingProvider(
      new FakeLlmProvider({ script: [] }),
      new FileFixtureStore(dir),
      { mode: "replay" },
    );
    const second = await replaying.complete(request("hi"));
    expect(second).toEqual(first);
    expect(inner.calls).toHaveLength(1);
  });

  it("replay is deterministic across repeated and reordered calls", async () => {
    const store = new InMemoryFixtureStore();
    const recorder = new RecordingProvider(
      new FakeLlmProvider({ script: [reply("A"), reply("B")] }),
      store,
      { mode: "record" },
    );
    await recorder.complete(request("a"));
    await recorder.complete(request("b"));
    const replayer = new RecordingProvider(new FakeLlmProvider({ script: [] }), store, {
      mode: "replay",
    });
    expect((await replayer.complete(request("b"))).content).toEqual([{ type: "text", text: "B" }]);
    expect((await replayer.complete(request("a"))).content).toEqual([{ type: "text", text: "A" }]);
    expect((await replayer.complete(request("a"))).content).toEqual([{ type: "text", text: "A" }]);
  });

  it("fails loudly on a missing fixture in replay mode with the key and a recording hint", async () => {
    const replayer = new RecordingProvider(
      new FakeLlmProvider({ script: [reply("should not be used")] }),
      new InMemoryFixtureStore(),
      { mode: "replay" },
    );
    const err = await replayer.complete(request("nothing recorded")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingFixtureError);
    expect((err as Error).message).toContain(fixtureKey(request("nothing recorded")));
    expect((err as Error).message).toMatch(/VO_LLM_FIXTURES=record/);
    expect((err as Error).message).toMatch(/claude-sonnet-5/);
  });

  it("auto mode replays when present and records when missing", async () => {
    const store = new InMemoryFixtureStore();
    const inner = new FakeLlmProvider({ script: [reply("first"), reply("second")] });
    const auto = new RecordingProvider(inner, store, { mode: "auto" });
    expect((await auto.complete(request("x"))).content).toEqual([{ type: "text", text: "first" }]);
    expect((await auto.complete(request("x"))).content).toEqual([{ type: "text", text: "first" }]);
    expect((await auto.complete(request("y"))).content).toEqual([{ type: "text", text: "second" }]);
    expect(inner.calls).toHaveLength(2);
    expect(auto.stats).toEqual({ hits: 1, misses: 2 });
  });

  it("re-records in record mode even when a fixture exists", async () => {
    const store = new InMemoryFixtureStore();
    await new RecordingProvider(new FakeLlmProvider({ script: [reply("old")] }), store, {
      mode: "record",
    }).complete(request("x"));
    await new RecordingProvider(new FakeLlmProvider({ script: [reply("new")] }), store, {
      mode: "record",
    }).complete(request("x"));
    const replayed = await new RecordingProvider(new FakeLlmProvider({ script: [] }), store, {
      mode: "replay",
    }).complete(request("x"));
    expect(replayed.content).toEqual([{ type: "text", text: "new" }]);
  });

  it("streams a replayed fixture as text deltas ending in the recorded response", async () => {
    const store = new InMemoryFixtureStore();
    await new RecordingProvider(new FakeLlmProvider({ script: [reply("streamed back")] }), store, {
      mode: "record",
    }).complete(request("s"));
    const replayer = new RecordingProvider(new FakeLlmProvider({ script: [] }), store, {
      mode: "replay",
    });
    const events = [];
    for await (const e of replayer.stream(request("s"))) events.push(e);
    expect(events.at(-1)?.type).toBe("done");
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("streamed back");
  });

  it("rejects a corrupt fixture file with a clear error", async () => {
    const dir = tempDir();
    const key = fixtureKey(request("bad"));
    writeFileSync(join(dir, `${key}.json`), "{ not json");
    const replayer = new RecordingProvider(
      new FakeLlmProvider({ script: [] }),
      new FileFixtureStore(dir),
      { mode: "replay" },
    );
    await expect(replayer.complete(request("bad"))).rejects.toThrow(/corrupt fixture/);
  });

  it("does not record provider errors, so a flaky recording run can be retried", async () => {
    const store = new InMemoryFixtureStore();
    const inner = new FakeLlmProvider({
      script: [
        new (await import("../provider/types.js")).LlmProviderError("unavailable", "down"),
        reply("fine"),
      ],
    });
    const recorder = new RecordingProvider(inner, store, { mode: "record" });
    await expect(recorder.complete(request("x"))).rejects.toMatchObject({ code: "unavailable" });
    expect(await store.get(fixtureKey(request("x")))).toBeNull();
    expect((await recorder.complete(request("x"))).content).toEqual([
      { type: "text", text: "fine" },
    ]);
  });
});
