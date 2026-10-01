/**
 * What a server needs to be told before it can listen.
 *
 * Everything is checked up front and reported together, for the reason the
 * worker's config says it: a process that fails one line at a time takes four
 * restarts to configure, and each restart looks like a different fault.
 *
 * Two defaults are deliberate rather than convenient. It listens on the
 * loopback, because binding every interface by default would put an office on
 * the network the moment somebody ran it to try it out. And it keeps everything
 * in memory, because somebody trying it out should get a working office rather
 * than a request for a database — a real deployment names its storage.
 *
 * The exception is the coordination store, which stays in memory even when the
 * records move: it is leader election between workers, nothing here reads it,
 * and pointing it at a database that cannot elect anybody would stop a server
 * that would otherwise have run perfectly well.
 */
import { err, ok, type Result, type ValidationError } from "@vo/core";
import type { StorageConfig } from "@vo/storage";

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  /** The one token that reaches this office. */
  readonly token: string;
  readonly ownerId: string;
  readonly storage: StorageConfig;
  readonly allowedOrigins: readonly string[];
  /**
   * A built canvas to serve from the office's own origin, or null for an office
   * that answers an API and nothing else. Serving it is what lets a browser
   * hold no credential: same origin, so the sign-in cookie is simply sent.
   */
  readonly webRoot: string | null;
}

export const DEFAULT_PORT = 3100;

type Env = Readonly<Record<string, string | undefined>>;

export function readServerConfig(env: Env): Result<ServerConfig> {
  const errors: ValidationError[] = [];

  const token = (env["VO_API_TOKEN"] ?? "").trim();
  if (token.length === 0) {
    errors.push({
      path: "VO_API_TOKEN",
      message: "is required: a server with no token is an office anybody can read",
    });
  }

  const rawPort = env["VO_PORT"];
  const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
  // Zero is allowed and means "choose one for me" — for a test or a one-off
  // run, where the server says which port it actually got. A real deployment
  // names its port.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push({ path: "VO_PORT", message: "must be a port number between 0 and 65535" });
  }

  const url = (name: string, fallback: string): URL | null => {
    const raw = (env[name] ?? fallback).trim();
    try {
      return new URL(raw);
    } catch {
      errors.push({ path: name, message: `"${raw}" is not a connection URL` });
      return null;
    }
  };

  // One URL for everything a record goes in, another for the documents. They
  // are separate because the adapters are: sqlite keeps records and not blobs,
  // so defaulting documents to the record store would fail later with a message
  // about adapters rather than about configuration.
  const records = url("VO_STORAGE", "memory:");
  const blobs = url("VO_BLOBS", "memory:");
  /**
   * Leader election, which is between workers and not something this server
   * reads at all. It gets its own setting, and its own default, because
   * following the records would make every sqlite deployment fail on startup:
   * the sqlite adapter keeps records, events and vectors, and does not elect
   * anybody. The variable is here for the day a shared queue needs one.
   */
  const coordination = url("VO_COORDINATION", "memory:");

  const webRoot = (env["VO_WEB_ROOT"] ?? "").trim();

  const allowedOrigins = (env["VO_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (errors.length > 0 || records === null || blobs === null || coordination === null) {
    return err(errors);
  }

  return ok({
    port,
    host: env["VO_HOST"] ?? "127.0.0.1",
    token,
    ownerId: env["VO_API_OWNER"] ?? "owner",
    storage: {
      relational: records,
      vector: records,
      events: records,
      coordination,
      blobs,
    },
    allowedOrigins,
    webRoot: webRoot.length === 0 ? null : webRoot,
  });
}
