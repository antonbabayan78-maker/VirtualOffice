import { describe, expect, it } from "vitest";
import type { OfficeId } from "@vo/core";
import { isErr, unwrap } from "@vo/core";
import {
  deliverAll,
  slackChannel,
  telegramChannel,
  type Notification,
  type NotificationChannel,
  type NotifyFetch,
} from "./channel.js";

const notification = (overrides: Partial<Notification> = {}): Notification => ({
  officeId: "office-acme" as OfficeId,
  kind: "budget.warned",
  subject: "Design is near its daily budget",
  body: "Spent $8.10 of $10.00 today.",
  ...overrides,
});

/** A fetch that records what it was asked and answers from a script. */
function scripted(answer: Response | Error = new Response("ok", { status: 200 })): {
  fetch: NotifyFetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone());
    },
  };
}

describe("telling Slack", () => {
  const hook = "https://hooks.slack.test/services/T/B/x";

  it("posts to the webhook it was given", async () => {
    const { fetch, calls } = scripted();
    await slackChannel({ webhookUrl: hook, fetch }).send(notification());

    expect(calls[0]?.url).toBe(hook);
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("says what happened, in one message somebody can read", async () => {
    const { fetch, calls } = scripted();
    await slackChannel({ webhookUrl: hook, fetch }).send(notification());

    const body = JSON.parse(String(calls[0]?.init.body)) as { text: string };
    expect(body.text).toContain("Design is near its daily budget");
    expect(body.text).toContain("$8.10");
  });

  it("reports a refusal rather than throwing", async () => {
    const { fetch } = scripted(new Response("invalid_token", { status: 403 }));
    const sent = await slackChannel({ webhookUrl: hook, fetch }).send(notification());

    expect(isErr(sent)).toBe(true);
    expect(isErr(sent) && sent.error[0]?.message).toMatch(/403|invalid_token/);
  });

  it("reports a network that was not there rather than throwing", async () => {
    const { fetch } = scripted(new Error("socket hang up"));
    expect(isErr(await slackChannel({ webhookUrl: hook, fetch }).send(notification()))).toBe(true);
  });

  it("does not put the webhook in what it reports, since that is the secret", async () => {
    // A failure gets logged, and a Slack webhook URL is a bearer credential:
    // anybody who reads the log could post to the channel for ever.
    const { fetch } = scripted(new Response("no", { status: 500 }));
    const sent = await slackChannel({ webhookUrl: hook, fetch }).send(notification());

    expect(isErr(sent) && JSON.stringify(sent.error)).not.toContain("T/B/x");
  });
});

describe("telling Telegram", () => {
  const options = { botToken: "123:AAbbCC", chatId: "-100999" };

  it("posts to the bot's sendMessage", async () => {
    const { fetch, calls } = scripted(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await telegramChannel({ ...options, fetch }).send(notification());

    expect(calls[0]?.url).toContain("/bot123:AAbbCC/sendMessage");
  });

  it("sends it to the chat it was told", async () => {
    const { fetch, calls } = scripted(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await telegramChannel({ ...options, fetch }).send(notification());

    const body = JSON.parse(String(calls[0]?.init.body)) as { chat_id: string; text: string };
    expect(body.chat_id).toBe("-100999");
    expect(body.text).toContain("Design is near its daily budget");
  });

  it("reads Telegram's own refusal, which arrives as a 200", async () => {
    // Telegram answers 200 with ok:false for a bad chat id. Trusting the status
    // alone would report a message nobody received as delivered.
    const { fetch } = scripted(
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 }),
    );
    const sent = await telegramChannel({ ...options, fetch }).send(notification());

    expect(isErr(sent)).toBe(true);
    expect(isErr(sent) && sent.error[0]?.message).toMatch(/chat not found/);
  });

  it("does not put the bot token in what it reports", async () => {
    const { fetch } = scripted(new Response("nope", { status: 401 }));
    const sent = await telegramChannel({ ...options, fetch }).send(notification());

    expect(isErr(sent) && JSON.stringify(sent.error)).not.toContain("AAbbCC");
  });
});

describe("telling everybody", () => {
  const ok: NotificationChannel = { send: () => Promise.resolve(unwrap0()) };
  const broken: NotificationChannel = {
    send: () => Promise.resolve({ ok: false as const, error: [{ path: "slack", message: "down" }] }),
  };
  const throws: NotificationChannel = {
    send: () => Promise.reject(new Error("exploded")),
  };
  function unwrap0() {
    return { ok: true as const, value: true as const };
  }

  it("tells every channel", async () => {
    let told = 0;
    const counting: NotificationChannel = {
      send: () => {
        told += 1;
        return Promise.resolve(unwrap0());
      },
    };
    await deliverAll([counting, counting, counting], notification());
    expect(told).toBe(3);
  });

  it("carries on when one channel refuses", async () => {
    let told = 0;
    const counting: NotificationChannel = {
      send: () => {
        told += 1;
        return Promise.resolve(unwrap0());
      },
    };
    await deliverAll([broken, counting], notification());
    expect(told).toBe(1);
  });

  it("carries on when one channel throws outright", async () => {
    // A channel is somebody else's HTTP endpoint. It can do anything.
    const problems = await deliverAll([throws, ok], notification());
    expect(problems).toHaveLength(1);
  });

  it("says what failed, so a silent channel is not mistaken for a quiet office", async () => {
    const problems = await deliverAll([broken], notification());
    expect(problems[0]).toMatch(/down/);
  });

  it("says nothing when everything got through", async () => {
    expect(await deliverAll([ok, ok], notification())).toEqual([]);
  });

  it("is content with no channels at all", async () => {
    expect(await deliverAll([], notification())).toEqual([]);
  });
});
