import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryRelationalStore } from "@vo/storage";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { tokenVerifier } from "./auth.js";
import { OfficeEventLog } from "./events.js";
import { buildServer } from "./server.js";

const TOKEN = "sk-owner";
let server: FastifyInstance;
let events: OfficeEventLog;
let port: number;

beforeEach(async () => {
  events = new OfficeEventLog({ now: () => 1_700_000_000_000, historyLimit: 3 });
  server = buildServer({
    store: new InMemoryRelationalStore(),
    events,
    verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
    forceCloseConnections: true,
  });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
});

afterEach(async () => {
  await server.close();
});

/** Opens a socket and collects what it is sent. */
function listen(query: string): {
  readonly socket: WebSocket;
  readonly messages: Record<string, unknown>[];
  opened: Promise<void>;
  next(count: number): Promise<void>;
} {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws?${query}`);
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (raw: Buffer) => {
    messages.push(JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.on("open", () => {
      resolve();
    });
    socket.on("error", reject);
  });
  const next = async (count: number): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (messages.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { socket, messages, opened, next };
}

describe("the event stream", () => {
  it("turns away a socket with no token", async () => {
    // Asked through inject rather than a real socket: what matters is that the
    // upgrade is refused before it is accepted, and a refused upgrade leaves a
    // half-open connection that stalls the server's shutdown in a test.
    const response = await server.inject({
      method: "GET",
      url: "/ws?officeId=office-1",
      headers: { connection: "upgrade", upgrade: "websocket" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("turns away a socket whose token it does not know", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/ws?officeId=office-1&token=sk-nonsense",
      headers: { connection: "upgrade", upgrade: "websocket" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("sends what happens while a client is listening", async () => {
    const client = listen(`officeId=office-1&token=${TOKEN}`);
    await client.opened;
    events.publish("office-1", { kind: "department.created", id: "d1" });
    await client.next(1);

    expect(client.messages[0]).toMatchObject({
      offset: 1,
      data: { kind: "department.created", id: "d1" },
    });
    client.socket.close();
  });

  it("says nothing about another office", async () => {
    const client = listen(`officeId=office-1&token=${TOKEN}`);
    await client.opened;
    events.publish("office-2", { kind: "department.created", id: "d1" });
    await client.next(1);
    expect(client.messages).toEqual([]);
    client.socket.close();
  });

  it("replays what a reconnecting client missed, then carries on live", async () => {
    events.publish("office-1", { kind: "a" });
    events.publish("office-1", { kind: "b" });

    // The client saw the first event before it dropped out.
    const client = listen(`officeId=office-1&token=${TOKEN}&since=1`);
    await client.opened;
    await client.next(1);
    expect(client.messages.map((m) => (m["data"] as { kind: string }).kind)).toEqual(["b"]);

    events.publish("office-1", { kind: "c" });
    await client.next(2);
    expect(client.messages.map((m) => (m["data"] as { kind: string }).kind)).toEqual(["b", "c"]);
    client.socket.close();
  });

  it("gives a brand new client the history it can still see", async () => {
    events.publish("office-1", { kind: "a" });
    events.publish("office-1", { kind: "b" });
    const client = listen(`officeId=office-1&token=${TOKEN}`);
    await client.opened;
    await client.next(2);
    expect(client.messages).toHaveLength(2);
    client.socket.close();
  });

  it("tells a client that fell too far behind, rather than handing it a gap", async () => {
    // The log keeps three; this client is asking from before that.
    for (const kind of ["a", "b", "c", "d", "e"]) events.publish("office-1", { kind });
    const client = listen(`officeId=office-1&token=${TOKEN}&since=1`);
    await client.opened;
    await client.next(1);

    expect(client.messages[0]).toMatchObject({ type: "gap" });
    client.socket.close();
  });

  it("stops listening when the client goes away", async () => {
    const client = listen(`officeId=office-1&token=${TOKEN}`);
    await client.opened;
    client.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Publishing after the socket closed must not throw or leak a listener.
    expect(() => events.publish("office-1", { kind: "after" })).not.toThrow();
  });
});
