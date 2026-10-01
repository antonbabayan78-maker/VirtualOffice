/**
 * Putting a server together from its configuration and starting it.
 *
 * Apart from `main` so that starting one is testable: a test can take a
 * configuration, get a real server on a real port, call it over HTTP and stop
 * it again, without a process, a signal handler or an environment.
 *
 * This is also the first place anything passes `notify`. Every piece below it —
 * the channels, the adapters, the crossing detection — was written and tested
 * while no process existed to hand them to each other, so a budget warning was
 * delivered precisely nowhere. That is what an entry point is for.
 */
import { openStorage, type Storage } from "@vo/storage";
import type { ServerConfig } from "./config.js";
import { buildServer } from "./server.js";
import { officeNotifier } from "./office-notifier.js";
import { tokenVerifier } from "./auth.js";

export interface StartedServer {
  /** Where it is actually listening; the port may have been chosen for it. */
  readonly url: string;
  storageClosed(): boolean;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Told about anything dropped on purpose: a channel that could not be reached. */
  readonly onProblem?: (message: string) => void;
}

export async function startServer(
  config: ServerConfig,
  options: StartOptions = {},
): Promise<StartedServer> {
  // Opened before the server is built: a server listening on half an office
  // would answer requests it cannot serve, and the adapter's own error names
  // the scheme that is missing.
  const storage: Storage = await openStorage({
    relational: config.storage.relational.href,
    vector: config.storage.vector.href,
    events: config.storage.events.href,
    coordination: config.storage.coordination.href,
    blobs: config.storage.blobs.href,
  });

  let storageClosed = false;

  const app = buildServer({
    store: storage.relational,
    blobs: storage.blobs,
    verifyToken: tokenVerifier({ [config.token]: { ownerId: config.ownerId } }),
    notify: officeNotifier(storage.relational, undefined, options.onProblem),
    allowedOrigins: config.allowedOrigins,
    // Served from the office's own origin when a deployment has one, which is
    // what lets the browser hold no credential at all.
    ...(config.webRoot === null ? {} : { webRoot: config.webRoot }),
    // Cut connections off rather than waiting for them to go idle: a refused
    // upgrade leaves a keep-alive socket nobody will use again.
    forceCloseConnections: true,
    logger: false,
  });

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    await storage.close();
    throw error;
  }

  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;

  return {
    url: `http://${config.host}:${String(port)}`,
    storageClosed: () => storageClosed,
    close: async () => {
      // Sockets first, then the store: a request in flight that outlived its
      // storage would fail in a way nobody could read.
      await app.close();
      await storage.close();
      storageClosed = true;
    },
  };
}
