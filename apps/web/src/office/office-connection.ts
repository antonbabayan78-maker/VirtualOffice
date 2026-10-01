/**
 * Connecting the application to its office, once.
 *
 * This used to live inside the canvas, which meant the office was loaded by the
 * screen that happened to need it first. Anybody landing on another address —
 * the usage figures, say — got an empty store and a page that looked broken,
 * and moving between sections tore the stream down and built it again.
 *
 * The office belongs to the application rather than to one of its screens, so
 * it is loaded where the application starts and every screen reads the same
 * store. Nothing here draws anything; a screen that wants to say "still
 * loading" asks the store what it holds.
 */
import type { ApiClient } from "@vo/api-client";
import type { ApiConfig } from "../api/config.js";
import { openOfficeStream, type OfficeStream, type StreamOptions } from "../api/stream.js";
import { followOffice } from "./follow.js";
import type { OfficeStore } from "./office-store.js";

export interface OfficeConnection {
  /** Settles when the first load has been applied, for a test to wait on. */
  readonly ready: Promise<void>;
  close(): void;
}

export interface ConnectOfficeOptions {
  readonly store: OfficeStore;
  readonly config: ApiConfig;
  readonly api: ApiClient;
  /** Injected so a test can drive the stream without a socket. */
  readonly openStream?: (options: StreamOptions) => OfficeStream;
}

export function connectOffice(options: ConnectOfficeOptions): OfficeConnection {
  const { store, config, api } = options;
  const open = options.openStream ?? openOfficeStream;

  // Before anything is loaded: until the store knows this, every drawer save
  // stops in the browser and tells the person it worked.
  store.getState().connect(api);
  const follower = followOffice({ store, api, officeId: config.officeId });

  const ready = follower.reload();
  const stream = open({
    url: config.streamUrl,
    token: config.token,
    officeId: config.officeId,
    since: () => store.getState().seenOffset,
    onEvent: (event) => {
      void follower.apply(event as never);
    },
    // Too far behind to be caught up: start again rather than stay wrong.
    onGap: () => {
      void follower.reload();
    },
  });

  return {
    ready,
    close: () => {
      stream.close();
    },
  };
}
