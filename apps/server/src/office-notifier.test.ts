import { describe, expect, it } from "vitest";
import { InMemoryRelationalStore } from "@vo/storage";
import {
  createNotificationChannel,
  unwrap,
  type NotificationChannelId,
  type OfficeId,
} from "@vo/core";
import { officeNotifier } from "./office-notifier.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-10-01T09:00:00Z");

const notification = {
  officeId,
  kind: "budget.warned",
  subject: "Design is near its budget",
  body: "Spent $8.10 of $10.00.",
};

async function storeWith(
  channels: readonly {
    kind: string;
    name: string;
    secret: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }[],
) {
  const store = new InMemoryRelationalStore();
  let n = 0;
  for (const channel of channels) {
    await store.channels.put(
      unwrap(
        createNotificationChannel({ officeId, ...channel }, [], {
          id: () => `chan-${String(++n)}` as NotificationChannelId,
          now: () => at,
        }),
      ),
    );
  }
  return store;
}

/** A fetch that records what it was asked, answering as the service would. */
function recording() {
  const calls: string[] = [];
  return {
    calls,
    fetch: ((url: string) => {
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as never,
  };
}

describe("sending word wherever the office has asked", () => {
  it("tells a Slack channel", async () => {
    const store = await storeWith([
      { kind: "slack", name: "ops", secret: "https://hooks.slack.test/a/b/c" },
    ]);
    const { fetch, calls } = recording();

    await officeNotifier(store, fetch)(notification);
    expect(calls[0]).toBe("https://hooks.slack.test/a/b/c");
  });

  it("tells a Telegram channel", async () => {
    const store = await storeWith([
      { kind: "telegram", name: "ops-tg", secret: "123:AA", config: { chatId: "-100" } },
    ]);
    const { fetch, calls } = recording();

    await officeNotifier(store, fetch)(notification);
    expect(calls[0]).toContain("/bot123:AA/sendMessage");
  });

  it("tells every channel the office has", async () => {
    const store = await storeWith([
      { kind: "slack", name: "ops", secret: "https://hooks.slack.test/a/b/c" },
      { kind: "telegram", name: "ops-tg", secret: "123:AA", config: { chatId: "-100" } },
    ]);
    const { fetch, calls } = recording();

    await officeNotifier(store, fetch)(notification);
    expect(calls).toHaveLength(2);
  });

  it("passes over a channel that has been switched off", async () => {
    const store = await storeWith([
      { kind: "slack", name: "ops", secret: "https://hooks.slack.test/a/b/c", enabled: false },
    ]);
    const { fetch, calls } = recording();

    await officeNotifier(store, fetch)(notification);
    expect(calls).toEqual([]);
  });

  it("sends nothing for an office with no channels, without complaining", async () => {
    const { fetch, calls } = recording();
    await officeNotifier(await storeWith([]), fetch)(notification);
    expect(calls).toEqual([]);
  });

  it("does not send one office's word to another's channels", async () => {
    const store = await storeWith([
      { kind: "slack", name: "ops", secret: "https://hooks.slack.test/a/b/c" },
    ]);
    const { fetch, calls } = recording();

    await officeNotifier(store, fetch)({ ...notification, officeId: "office-other" as OfficeId });
    expect(calls).toEqual([]);
  });

  it("does not throw when a channel is down", async () => {
    // The office must not stop because Slack did.
    const store = await storeWith([
      { kind: "slack", name: "ops", secret: "https://hooks.slack.test/a/b/c" },
    ]);
    const exploding = (() => Promise.reject(new Error("socket hang up"))) as never;

    await expect(officeNotifier(store, exploding)(notification)).resolves.toBeUndefined();
  });

  it("says what could not be delivered, so a silent channel is noticed", async () => {
    const problems: string[] = [];
    const store = await storeWith([
      { kind: "slack", name: "ops", secret: "https://hooks.slack.test/a/b/c" },
    ]);
    const exploding = (() => Promise.reject(new Error("socket hang up"))) as never;

    await officeNotifier(store, exploding, (message) => problems.push(message))(notification);
    expect(problems.join(" ")).toMatch(/socket hang up/);
  });

  it("does not put a channel's secret in what it reports", async () => {
    const problems: string[] = [];
    const store = await storeWith([
      { kind: "slack", name: "ops", secret: "https://hooks.slack.test/secret-path" },
    ]);
    const exploding = (() => Promise.reject(new Error("nope"))) as never;

    await officeNotifier(store, exploding, (message) => problems.push(message))(notification);
    expect(problems.join(" ")).not.toContain("secret-path");
  });

  it("reads the office's channels each time, so one added now is used now", async () => {
    // Built once at startup, before any office exists; a channel added on the
    // canvas must work without restarting the server.
    const store = await storeWith([]);
    const { fetch, calls } = recording();
    const notify = officeNotifier(store, fetch);

    await notify(notification);
    expect(calls).toEqual([]);

    await store.channels.put(
      unwrap(
        createNotificationChannel(
          { officeId, kind: "slack", name: "late", secret: "https://hooks.slack.test/late" },
          [],
          { id: () => "chan-late" as NotificationChannelId, now: () => at },
        ),
      ),
    );
    await notify(notification);
    expect(calls).toHaveLength(1);
  });
});
