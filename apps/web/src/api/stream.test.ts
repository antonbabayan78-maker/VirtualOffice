import { describe, expect, it, vi } from "vitest";
import { openOfficeStream, type StreamSocket } from "./stream.js";

/** A socket this test drives by hand. */
function fakeSockets(): {
  readonly urls: string[];
  readonly open: FakeSocket[];
  factory: (url: string) => StreamSocket;
} {
  const urls: string[] = [];
  const open: FakeSocket[] = [];
  return {
    urls,
    open,
    factory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      open.push(socket);
      return socket;
    },
  };
}

class FakeSocket implements StreamSocket {
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  drop(): void {
    this.onclose?.();
  }
}

const options = (sockets: ReturnType<typeof fakeSockets>, since = () => 0) => ({
  url: "ws://office.test/ws",
  token: "sk-owner",
  officeId: "office-1",
  since,
  socketFactory: sockets.factory,
  reconnectDelayMs: 5,
});

describe("the office stream", () => {
  it("connects saying who it is and where it got to", () => {
    const sockets = fakeSockets();
    const stream = openOfficeStream({ ...options(sockets, () => 12), onEvent: () => undefined });
    expect(sockets.urls[0]).toBe("ws://office.test/ws?officeId=office-1&token=sk-owner&since=12");
    stream.close();
  });

  it("passes on what the office says happened", () => {
    const sockets = fakeSockets();
    const heard: unknown[] = [];
    const stream = openOfficeStream({
      ...options(sockets),
      onEvent: (event) => {
        heard.push(event);
      },
    });
    sockets.open[0]?.deliver({ offset: 1, officeId: "office-1", at: 0, data: { kind: "a" } });
    expect(heard).toHaveLength(1);
    stream.close();
  });

  it("ignores a message that is not an event, rather than throwing", () => {
    const sockets = fakeSockets();
    const heard: unknown[] = [];
    const stream = openOfficeStream({
      ...options(sockets),
      onEvent: (event) => {
        heard.push(event);
      },
    });
    sockets.open[0]?.onmessage?.({ data: "not json at all" });
    sockets.open[0]?.deliver({ something: "unexpected" });
    expect(heard).toEqual([]);
    stream.close();
  });

  it("says when it has fallen too far behind to follow", () => {
    const sockets = fakeSockets();
    const gaps: number[] = [];
    const stream = openOfficeStream({
      ...options(sockets),
      onEvent: () => undefined,
      onGap: () => gaps.push(1),
    });
    sockets.open[0]?.deliver({ type: "gap", message: "too far behind" });
    expect(gaps).toHaveLength(1);
    stream.close();
  });

  it("comes back after being dropped, asking for what it missed", async () => {
    vi.useFakeTimers();
    const sockets = fakeSockets();
    let seen = 3;
    const stream = openOfficeStream({
      ...options(sockets, () => seen),
      onEvent: () => undefined,
    });

    seen = 8;
    sockets.open[0]?.drop();
    await vi.advanceTimersByTimeAsync(10);

    expect(sockets.urls).toHaveLength(2);
    expect(sockets.urls[1]).toContain("since=8");
    stream.close();
    vi.useRealTimers();
  });

  it("stays away once it has been closed", async () => {
    vi.useFakeTimers();
    const sockets = fakeSockets();
    const stream = openOfficeStream({ ...options(sockets), onEvent: () => undefined });

    stream.close();
    sockets.open[0]?.drop();
    await vi.advanceTimersByTimeAsync(50);

    expect(sockets.urls).toHaveLength(1);
    expect(sockets.open[0]?.closed).toBe(true);
    vi.useRealTimers();
  });
});
