import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChangeFeed,
  PollingChangeFeed,
  type ChangeFeed,
  type PushCapableEventStore,
} from "./change-feed.js";
import { InMemoryEventStore } from "./in-memory.js";
import type { StoredEvent } from "./types.js";

const ev = (id: string, at: Date, officeId = "o1"): StoredEvent => ({
  id,
  officeId,
  at,
  type: "task.updated",
  payload: { id },
});

describe("PollingChangeFeed (listenNotify fallback)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers events appended after subscription, in order, without duplicates", async () => {
    const store = new InMemoryEventStore();
    await store.append([ev("old", new Date("2026-09-22T09:00:00Z"))]);
    const feed = new PollingChangeFeed(store, { intervalMs: 100, maxIntervalMs: 1000 });
    const seen: string[] = [];
    const unsubscribe = feed.subscribe("o1", (e) => {
      seen.push(e.id);
    });
    await store.append([
      ev("a", new Date("2026-09-22T10:00:01Z")),
      ev("b", new Date("2026-09-22T10:00:02Z")),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual(["a", "b"]);
    await store.append([ev("c", new Date("2026-09-22T10:00:03Z"))]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual(["a", "b", "c"]);
    unsubscribe();
    await feed.close();
  });

  it("backs off while idle and resets after activity", async () => {
    const store = new InMemoryEventStore();
    const spy = vi.spyOn(store, "query");
    const feed = new PollingChangeFeed(store, { intervalMs: 100, maxIntervalMs: 800 });
    feed.subscribe("o1", () => undefined);
    await vi.advanceTimersByTimeAsync(100); // poll 1 (idle) -> next in 200
    await vi.advanceTimersByTimeAsync(200); // poll 2 (idle) -> next in 400
    await vi.advanceTimersByTimeAsync(400); // poll 3 (idle) -> next in 800
    expect(spy).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(700);
    expect(spy).toHaveBeenCalledTimes(3);
    await store.append([ev("a", new Date())]);
    await vi.advanceTimersByTimeAsync(100); // poll 4 finds a -> interval resets to 100
    expect(spy).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(spy).toHaveBeenCalledTimes(5);
    await feed.close();
  });

  it("isolates offices and stops polling when the last subscriber leaves", async () => {
    const store = new InMemoryEventStore();
    const spy = vi.spyOn(store, "query");
    const feed = new PollingChangeFeed(store, { intervalMs: 50, maxIntervalMs: 50 });
    const o1: string[] = [];
    const o2: string[] = [];
    const u1 = feed.subscribe("o1", (e) => {
      o1.push(e.id);
    });
    const u2 = feed.subscribe("o2", (e) => {
      o2.push(e.id);
    });
    await store.append([ev("x", new Date(), "o1"), ev("y", new Date(), "o2")]);
    await vi.advanceTimersByTimeAsync(50);
    expect(o1).toEqual(["x"]);
    expect(o2).toEqual(["y"]);
    u1();
    u2();
    const calls = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(spy.mock.calls.length).toBe(calls);
    await feed.close();
  });
});

describe("createChangeFeed", () => {
  it("uses the store's push feed when it has listenNotify, polling otherwise", async () => {
    const polling = createChangeFeed(new InMemoryEventStore(), {
      intervalMs: 10,
      maxIntervalMs: 10,
    });
    expect(polling).toBeInstanceOf(PollingChangeFeed);
    await polling.close();

    const pushFeed: ChangeFeed = {
      subscribe: () => () => undefined,
      close: () => Promise.resolve(),
    };
    const pushStore: PushCapableEventStore = Object.assign(new InMemoryEventStore(), {
      capabilities: { ...new InMemoryEventStore().capabilities, listenNotify: true },
      changeFeed: () => pushFeed,
    });
    expect(createChangeFeed(pushStore)).toBe(pushFeed);
  });
});
