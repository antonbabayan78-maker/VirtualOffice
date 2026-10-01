/**
 * The office's event stream, and getting back to it.
 *
 * A dropped connection is normal — a laptop closes, a proxy times out — so the
 * stream reconnects on its own and asks for what it missed. It asks using the
 * offset the client has *now*, not the one it had when it first connected, so a
 * reconnect resumes rather than replaying what has already been applied.
 *
 * A browser cannot put headers on a WebSocket. A canvas that was given a token
 * therefore puts it in the query string; one that signed in puts nothing there
 * at all, because the cookie the office set travels with the upgrade on its own
 * — and a token in a query string is a token in every proxy log between here and
 * the office. Either way the server refuses the upgrade before accepting it.
 */
export interface StreamSocket {
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface StreamOptions {
  readonly url: string;
  /** Absent when the browser has signed in: the cookie is the credential. */
  readonly token?: string;
  readonly officeId: string;
  /** Read at connect time, so a reconnect resumes from where the canvas is. */
  readonly since: () => number;
  readonly onEvent: (event: Record<string, unknown>) => void;
  /** Called when the office can no longer say what was missed. */
  readonly onGap?: () => void;
  readonly reconnectDelayMs?: number;
  readonly socketFactory?: (url: string) => StreamSocket;
}

export const DEFAULT_RECONNECT_MS = 2_000;

export interface OfficeStream {
  close(): void;
}

export function openOfficeStream(options: StreamOptions): OfficeStream {
  const makeSocket =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as StreamSocket);
  const delay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;

  let socket: StreamSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wanted = true;

  const connect = (): void => {
    if (!wanted) return;
    const query = new URLSearchParams({
      officeId: options.officeId,
      ...(options.token === undefined ? {} : { token: options.token }),
      since: String(options.since()),
    });
    const next = makeSocket(`${options.url}?${query.toString()}`);
    socket = next;

    next.onmessage = (message) => {
      let payload: unknown;
      try {
        payload = JSON.parse(message.data);
      } catch {
        // Not something this client understands; the office will say it again
        // if it mattered, and a stream is not worth crashing a canvas over.
        return;
      }
      if (typeof payload !== "object" || payload === null) return;
      const record = payload as Record<string, unknown>;
      if (record["type"] === "gap") {
        options.onGap?.();
        return;
      }
      if (typeof record["offset"] !== "number") return;
      options.onEvent(record);
    };

    // A failed connection fires onerror AND onclose, so this socket gets at
    // most one retry however many times the browser says it has gone. Retrying
    // on both doubled the sockets every cycle — 1, 2, 4, 8 — until the browser
    // refused to open any more and the canvas was wedged.
    let retried = false;
    const retry = (): void => {
      if (!wanted || retried) return;
      retried = true;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(connect, delay);
    };
    next.onclose = retry;
    next.onerror = retry;
  };

  connect();

  return {
    close: () => {
      wanted = false;
      if (timer !== null) clearTimeout(timer);
      socket?.close();
    },
  };
}
