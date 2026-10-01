/**
 * Where an office sends word when something happens.
 *
 * Shaped like a connector, because it is the same kind of thing: a named,
 * switchable way of reaching something outside the office, configured once and
 * used by whatever needs it. An office has a handful.
 *
 * **The secret is write-only.** A Slack webhook URL and a Telegram bot token
 * are bearer credentials — anybody holding one can post to that channel for
 * ever — so it is accepted on the way in and never leaves: `redactChannel` is
 * what any route returns, and it answers "is one configured" rather than
 * "which one". A patch that says nothing about the secret keeps the one it
 * has, because a canvas never has it to send back and would otherwise wipe it
 * on every rename.
 *
 * `Connector.secretRef` points into the vault instead, which is the better
 * home and has had no consumer since the day it was written. Wiring that in is
 * its own task; until then the secret lives on the row, and this comment is
 * the honest version of that rather than a pretence.
 */
import type { OfficeId } from "../office/office.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

declare const channelIdBrand: unique symbol;
export type NotificationChannelId = string & { readonly [channelIdBrand]: true };

export const CHANNEL_KINDS = ["slack", "telegram"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === "string" && (CHANNEL_KINDS as readonly string[]).includes(value);
}

export interface NotificationChannelRecord {
  readonly id: NotificationChannelId;
  readonly officeId: OfficeId;
  readonly kind: ChannelKind;
  /** Unique per office, so a person can say which one they mean. */
  readonly name: string;
  /** The credential. Never returned by a route; see `redactChannel`. */
  readonly secret: string;
  /** Whatever else the kind needs — a Telegram chat id, say. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
  readonly createdAt: Date;
}

export interface CreateChannelInput {
  readonly officeId: OfficeId;
  readonly kind: unknown;
  readonly name: unknown;
  readonly secret?: unknown;
  readonly config?: Record<string, unknown>;
  readonly enabled?: boolean;
}

export interface UpdateChannelInput {
  readonly name?: unknown;
  readonly secret?: unknown;
  readonly config?: Record<string, unknown>;
  readonly enabled?: boolean;
}

export interface ChannelDeps {
  readonly id: () => NotificationChannelId;
  readonly now: () => Date;
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a kind needs beyond its secret before it can address anybody. */
function configProblems(kind: ChannelKind, config: Record<string, unknown>): ValidationError[] {
  if (kind !== "telegram") return [];
  const chatId = config["chatId"];
  // A bot token alone cannot address anybody.
  return typeof chatId === "string" && chatId.length > 0
    ? []
    : [{ path: "config.chatId", message: "a telegram channel needs a chat to post in" }];
}

function nameProblems(
  raw: unknown,
  existing: readonly { readonly name: string }[],
): { name: string; errors: ValidationError[] } {
  const name = typeof raw === "string" ? raw.trim() : "";
  const errors: ValidationError[] = [];
  if (!NAME.test(name)) {
    errors.push({ path: "name", message: "must be a kebab-case identifier of 1-64 characters" });
  } else if (existing.some((other) => other.name.toLowerCase() === name.toLowerCase())) {
    errors.push({ path: "name", message: `a channel named "${name}" already exists` });
  }
  return { name, errors };
}

export function createNotificationChannel(
  input: CreateChannelInput,
  existing: readonly { readonly name: string }[],
  deps: ChannelDeps,
): Result<NotificationChannelRecord> {
  const errors: ValidationError[] = [];

  if (!isChannelKind(input.kind)) {
    errors.push({ path: "kind", message: `must be one of ${CHANNEL_KINDS.join(", ")}` });
  }
  const { name, errors: nameErrors } = nameProblems(input.name, existing);
  errors.push(...nameErrors);

  const secret = typeof input.secret === "string" ? input.secret.trim() : "";
  if (secret.length === 0) {
    errors.push({
      path: "secret",
      message: "is required; a channel with none can deliver nothing",
    });
  }

  const config = input.config ?? {};
  if (!isRecord(config)) errors.push({ path: "config", message: "must be an object" });
  else if (isChannelKind(input.kind)) errors.push(...configProblems(input.kind, config));

  if (errors.length > 0 || !isChannelKind(input.kind) || !isRecord(config)) return err(errors);

  return ok({
    id: deps.id(),
    officeId: input.officeId,
    kind: input.kind,
    name,
    secret,
    config: { ...config },
    enabled: input.enabled ?? true,
    createdAt: deps.now(),
  });
}

export function updateNotificationChannel(
  channel: NotificationChannelRecord,
  changes: UpdateChannelInput,
  existing: readonly { readonly name: string }[],
): Result<NotificationChannelRecord> {
  const errors: ValidationError[] = [];

  const name =
    changes.name === undefined
      ? channel.name
      : (() => {
          const checked = nameProblems(
            changes.name,
            existing.filter((other) => other.name !== channel.name),
          );
          errors.push(...checked.errors);
          return checked.name;
        })();

  // Absent keeps the one it has: a canvas never holds the secret, so a patch
  // that omitted it would wipe delivery on every rename.
  let secret = channel.secret;
  if (changes.secret !== undefined) {
    const given = typeof changes.secret === "string" ? changes.secret.trim() : "";
    if (given.length === 0) {
      errors.push({ path: "secret", message: "must not be emptied; remove the channel instead" });
    } else secret = given;
  }

  const config = changes.config ?? channel.config;
  if (!isRecord(config)) errors.push({ path: "config", message: "must be an object" });
  else errors.push(...configProblems(channel.kind, config));

  const enabled = changes.enabled ?? channel.enabled;
  if (typeof enabled !== "boolean")
    errors.push({ path: "enabled", message: "must be true or false" });

  if (errors.length > 0 || !isRecord(config) || typeof enabled !== "boolean") return err(errors);
  return ok({ ...channel, name, secret, config: { ...config }, enabled });
}

/** A channel as it leaves the office: everything except the credential. */
export function redactChannel(
  channel: NotificationChannelRecord,
): Omit<NotificationChannelRecord, "secret"> & { readonly hasSecret: boolean } {
  const { secret, ...rest } = channel;
  return { ...rest, hasSecret: secret.length > 0 };
}
