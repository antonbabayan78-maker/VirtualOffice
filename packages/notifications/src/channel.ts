/**
 * Telling somebody outside the office that something happened.
 *
 * A channel is somebody else's HTTP endpoint, so it can do anything: refuse,
 * hang up, answer 200 and mean no. Nothing here throws at a caller — a failed
 * notification is reported and the office carries on, because an outage at
 * Slack must never become an outage here. That is the rule the whole
 * notifications task is written around, and it is easier to hold now than to
 * retrofit later.
 *
 * `fetch` is injected, as the web connector's is, so every test of these is
 * offline and no test can post into a real channel by accident.
 *
 * **A channel's credential never appears in what it reports.** A Slack webhook
 * URL and a Telegram bot token are bearer credentials: anybody who could read a
 * log line containing one could post to that channel for ever. Failures name
 * the channel and the status, never the secret.
 */
import { err, ok, type OfficeId, type Result } from "@vo/core";

export type NotifyFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface Notification {
  readonly officeId: OfficeId;
  /** What happened: "budget.warned" today, more as they are routed. */
  readonly kind: string;
  readonly subject: string;
  readonly body: string;
}

export interface NotificationChannel {
  /** Err is a delivery that did not happen, never a reason to stop working. */
  send(notification: Notification): Promise<Result<true>>;
}

/** One message, for channels that take a single block of text. */
const asText = (notification: Notification): string =>
  `${notification.subject}\n${notification.body}`;

const failed = (channel: string, reason: string): Result<true> =>
  err([{ path: channel, message: reason }]);

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface SlackOptions {
  /** An incoming-webhook URL. This is the credential; it is never logged. */
  readonly webhookUrl: string;
  readonly fetch?: NotifyFetch;
}

export function slackChannel(options: SlackOptions): NotificationChannel {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  return {
    send: async (notification) => {
      try {
        const response = await doFetch(options.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: asText(notification) }),
        });
        if (response.ok) return ok(true);
        // The body, not the URL: Slack says "invalid_token" or "no_service"
        // here, and that is the useful half.
        return failed("slack", `${String(response.status)}: ${await response.text()}`);
      } catch (error) {
        return failed("slack", reasonOf(error));
      }
    },
  };
}

export interface TelegramOptions {
  /** A bot token. This is the credential; it is never logged. */
  readonly botToken: string;
  readonly chatId: string;
  readonly fetch?: NotifyFetch;
}

export function telegramChannel(options: TelegramOptions): NotificationChannel {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  return {
    send: async (notification) => {
      try {
        const response = await doFetch(
          `https://api.telegram.org/bot${options.botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: options.chatId, text: asText(notification) }),
          },
        );
        if (!response.ok) return failed("telegram", `refused with ${String(response.status)}`);

        // Telegram answers 200 with ok:false for a chat it cannot find, so the
        // status alone would report a message nobody received as delivered.
        const answer = (await response.json()) as { ok?: boolean; description?: string };
        if (answer.ok === true) return ok(true);
        return failed("telegram", answer.description ?? "refused without saying why");
      } catch (error) {
        return failed("telegram", reasonOf(error));
      }
    },
  };
}

/**
 * Tells every channel, and says which ones could not be told.
 *
 * Every channel is tried whatever the others did: one broken webhook must not
 * cost the others their message. Nothing is thrown, including by a channel that
 * throws itself — it is somebody else's endpoint and it can do anything.
 */
export async function deliverAll(
  channels: readonly NotificationChannel[],
  notification: Notification,
): Promise<readonly string[]> {
  const outcomes = await Promise.all(
    channels.map(async (channel) => {
      try {
        const sent = await channel.send(notification);
        return sent.ok
          ? null
          : sent.error.map((problem) => `${problem.path}: ${problem.message}`).join("; ");
      } catch (error) {
        return reasonOf(error);
      }
    }),
  );
  return outcomes.filter((problem): problem is string => problem !== null);
}
