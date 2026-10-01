/**
 * Turning an office's configured channels into somewhere to send word.
 *
 * The server knows nothing about Slack or Telegram — it takes a `notify`
 * function and calls it. This is the function, and it lives here because this
 * is the process that holds both the channel rows and the credentials to use
 * them. A worker could not do it: it has no store, and the secret is
 * deliberately never sent over the wire.
 *
 * The office is read **each time**, not once at startup: this is built before
 * any office exists, and a channel added on the canvas should start working
 * without restarting the server — the same reason `officeTools` asks the office
 * what it can reach on every call.
 *
 * Nothing here throws. An office must not stop because Slack did.
 */
import {
  deliverAll,
  slackChannel,
  telegramChannel,
  type Notification,
  type NotificationChannel,
  type NotifyFetch,
} from "@vo/notifications";
import type { NotificationChannelRecord } from "@vo/core";
import type { RelationalStore } from "@vo/storage";

function channelFor(
  record: NotificationChannelRecord,
  fetch: NotifyFetch | undefined,
): NotificationChannel | null {
  const injected = fetch === undefined ? {} : { fetch };
  if (record.kind === "slack") {
    return slackChannel({ webhookUrl: record.secret, ...injected });
  }
  const chatId = record.config["chatId"];
  // A telegram row without one is refused when it is made; a file written
  // before that rule would be passed over rather than sent nowhere.
  if (typeof chatId !== "string" || chatId.length === 0) return null;
  return telegramChannel({ botToken: record.secret, chatId, ...injected });
}

export function officeNotifier(
  store: RelationalStore,
  fetch?: NotifyFetch,
  onProblem?: (message: string) => void,
): (notification: Notification) => Promise<void> {
  return async (notification: Notification): Promise<void> => {
    const rows = await store.channels.list({
      where: { officeId: notification.officeId },
    });
    const channels = rows.items
      .filter((record) => record.enabled)
      .map((record) => channelFor(record, fetch))
      .filter((channel): channel is NotificationChannel => channel !== null);

    // `deliverAll` tries every one whatever the others did, and reports rather
    // than throws — the secrets never appear in what comes back.
    const problems = await deliverAll(channels, notification);
    for (const problem of problems) {
      onProblem?.(`could not send ${notification.kind} for ${notification.officeId}: ${problem}`);
    }
  };
}
