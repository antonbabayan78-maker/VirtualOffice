import { describe, expect, it } from "vitest";
import type { OfficeId } from "../office/office.js";
import { isErr, unwrap } from "../shared/result.js";
import {
  CHANNEL_KINDS,
  createNotificationChannel,
  redactChannel,
  updateNotificationChannel,
  type NotificationChannelId,
  type NotificationChannelRecord,
} from "./notification-channel.js";

const officeId = "office-1" as OfficeId;
const now = new Date("2026-10-01T09:00:00Z");
const deps = { id: () => "chan-1" as NotificationChannelId, now: () => now };

const slack = (overrides: Record<string, unknown> = {}) =>
  createNotificationChannel(
    {
      officeId,
      kind: "slack",
      name: "ops-alerts",
      secret: "https://hooks.slack.test/services/T/B/x",
      ...overrides,
    },
    [],
    deps,
  );

describe("the channels an office can be told through", () => {
  it("names them", () => {
    expect(CHANNEL_KINDS).toEqual(["slack", "telegram"]);
  });
});

describe("adding a channel", () => {
  it("makes one", () => {
    const made = unwrap(slack());
    expect(made).toMatchObject({ kind: "slack", name: "ops-alerts", enabled: true });
  });

  it("keeps the secret, because something has to send with it", () => {
    expect(unwrap(slack()).secret).toContain("hooks.slack.test");
  });

  it("takes the extra a channel needs, like which chat to post in", () => {
    const made = unwrap(
      createNotificationChannel(
        { officeId, kind: "telegram", name: "ops", secret: "123:AA", config: { chatId: "-100" } },
        [],
        deps,
      ),
    );
    expect(made.config["chatId"]).toBe("-100");
  });

  it("refuses a kind nobody can deliver to", () => {
    expect(isErr(slack({ kind: "carrier-pigeon" }))).toBe(true);
  });

  it("refuses one with no secret, which could deliver nothing", () => {
    expect(isErr(slack({ secret: "" }))).toBe(true);
    expect(isErr(slack({ secret: undefined }))).toBe(true);
  });

  it("refuses a second channel with the same name", () => {
    const first = unwrap(slack());
    expect(
      isErr(
        createNotificationChannel(
          { officeId, kind: "slack", name: "ops-alerts", secret: "x" },
          [first],
          deps,
        ),
      ),
    ).toBe(true);
  });

  it("refuses a telegram channel with no chat to post in", () => {
    // A bot token alone cannot address anybody.
    expect(
      isErr(
        createNotificationChannel(
          { officeId, kind: "telegram", name: "ops", secret: "123:AA" },
          [],
          deps,
        ),
      ),
    ).toBe(true);
  });
});

describe("changing a channel", () => {
  it("switches one off without losing it", () => {
    const made = unwrap(slack());
    expect(unwrap(updateNotificationChannel(made, { enabled: false }, [])).enabled).toBe(false);
  });

  it("keeps the secret when the change says nothing about it", () => {
    // A canvas never has the secret to send back, so a patch that omitted it
    // would wipe it on every rename.
    const made = unwrap(slack());
    const renamed = unwrap(updateNotificationChannel(made, { name: "alerts" }, []));
    expect(renamed.secret).toBe(made.secret);
  });

  it("replaces the secret when a new one is given", () => {
    const made = unwrap(slack());
    expect(
      unwrap(updateNotificationChannel(made, { secret: "https://new.test/x" }, [])).secret,
    ).toBe("https://new.test/x");
  });

  it("refuses an empty secret, which would silently stop delivery", () => {
    expect(isErr(updateNotificationChannel(unwrap(slack()), { secret: "" }, []))).toBe(true);
  });
});

describe("what leaves the office", () => {
  it("never carries the secret", () => {
    // Anybody who can open the canvas can read this. A Slack webhook is a
    // bearer credential: reading it is posting to the channel for ever.
    const made = unwrap(slack());
    const shown = redactChannel(made);

    expect(JSON.stringify(shown)).not.toContain("hooks.slack.test");
    expect("secret" in shown).toBe(false);
  });

  it("says whether one is configured, since that is what anybody needs to know", () => {
    expect(redactChannel(unwrap(slack())).hasSecret).toBe(true);
  });

  it("keeps everything that is not the secret", () => {
    const shown = redactChannel(unwrap(slack())) as unknown as NotificationChannelRecord;
    expect(shown).toMatchObject({ id: "chan-1", kind: "slack", name: "ops-alerts" });
  });
});
