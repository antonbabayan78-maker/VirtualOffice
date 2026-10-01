import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unwrap } from "@vo/core";
import { readServerConfig } from "./config.js";
import { startServer } from "./start.js";

const config = (overrides: Record<string, string | undefined> = {}) =>
  unwrap(readServerConfig({ VO_API_TOKEN: "sk-owner", VO_PORT: "0", ...overrides }));

/** Starts one, runs the body, and always stops it. */
async function running<T>(
  overrides: Record<string, string | undefined>,
  body: (started: Awaited<ReturnType<typeof startServer>>) => Promise<T>,
): Promise<T> {
  const started = await startServer(config(overrides));
  try {
    return await body(started);
  } finally {
    await started.close();
  }
}

const get = (url: string, token = "sk-owner") =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });

describe("starting a server from its configuration", () => {
  it("listens, and says where", async () => {
    await running({}, async (started) => {
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(`${started.url}/health`)).status).toBe(200);
    });
  });

  it("lets the configured token in", async () => {
    await running({}, async (started) => {
      expect((await get(`${started.url}/offices`)).status).toBe(200);
    });
  });

  it("keeps everybody else out", async () => {
    await running({}, async (started) => {
      expect((await get(`${started.url}/offices`, "sk-nonsense")).status).toBe(401);
    });
  });

  it("serves an office that can be made and read back", async () => {
    await running({}, async (started) => {
      const made = await fetch(`${started.url}/offices`, {
        method: "POST",
        headers: { authorization: "Bearer sk-owner", "content-type": "application/json" },
        body: JSON.stringify({ name: "Northwind" }),
      });
      expect(made.status).toBe(201);

      const listed = (await (await get(`${started.url}/offices`)).json()) as {
        items: { name: string }[];
      };
      expect(listed.items.map((one) => one.name)).toEqual(["Northwind"]);
    });
  });

  it("has somewhere to put documents, so the trays are there at all", async () => {
    // The document routes are simply absent without a blob store, and an office
    // whose trays silently did not exist would be a confusing first run.
    await running({}, async (started) => {
      const made = await fetch(`${started.url}/offices`, {
        method: "POST",
        headers: { authorization: "Bearer sk-owner", "content-type": "application/json" },
        body: JSON.stringify({ name: "Northwind" }),
      });
      const officeId = ((await made.json()) as { id: string }).id;

      expect((await get(`${started.url}/offices/${officeId}/documents`)).status).toBe(200);
    });
  });

  it("sends word where the office has asked, which nothing did before", async () => {
    // The whole reason this entry point exists. Every piece below it was built
    // and tested while no process passed `notify`, so a budget warning was
    // delivered precisely nowhere. This is that end to end, over real sockets.
    const received: { text: string }[] = [];
    const listener = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        received.push(JSON.parse(body) as { text: string });
        response.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", resolve);
    });
    const listenerPort = (listener.address() as { port: number }).port;

    try {
      await running({}, async (started) => {
        const post = (path: string, body: unknown) =>
          fetch(`${started.url}${path}`, {
            method: "POST",
            headers: { authorization: "Bearer sk-owner", "content-type": "application/json" },
            body: JSON.stringify(body),
          });

        const office = (await (await post("/offices", { name: "Northwind" })).json()) as {
          id: string;
        };
        await fetch(`${started.url}/offices/${office.id}`, {
          method: "PATCH",
          headers: { authorization: "Bearer sk-owner", "content-type": "application/json" },
          body: JSON.stringify({ budget: { limitUsd: 10, warnAtUsd: 8, period: "day" } }),
        });
        await post(`/offices/${office.id}/channels`, {
          kind: "slack",
          name: "ops",
          secret: `http://127.0.0.1:${String(listenerPort)}/hook`,
        });
        await post(`/offices/${office.id}/usage`, {
          id: "ev-1",
          kind: "llm_call",
          at: Date.now(),
          attribution: { officeId: office.id },
          durationMs: 1,
          ok: true,
          provider: "anthropic",
          model: "claude-sonnet-5",
          usage: {},
          cost: { totalUsd: 9 },
          streamed: false,
        });

        expect(received).toHaveLength(1);
        expect(received[0]?.text).toContain("near its budget");
      });
    } finally {
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
    }
  });

  it("stops cleanly, and lets go of the port", async () => {
    const started = await startServer(config());
    const url = started.url;
    await started.close();

    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it("closes its storage when it stops, not only its sockets", async () => {
    // A file-backed store left open outlives the process on some platforms and
    // keeps a lock nothing will release.
    const started = await startServer(config());
    await started.close();
    expect(started.storageClosed()).toBe(true);
  });
});

describe("a server that keeps an office on disk, which is what a deployment is", () => {
  const onDisk = (): Promise<string> => mkdtemp(join(tmpdir(), "vo-start-"));

  it("starts on sqlite and a directory of documents", async () => {
    // Nothing had ever run the server on anything but memory, and the first
    // thing that tried found it could not open one of the five stores at all.
    const dir = await onDisk();
    await running(
      { VO_STORAGE: `sqlite:${dir}/office.db`, VO_BLOBS: `file:${dir}/blobs` },
      async (started) => {
        expect((await fetch(`${started.url}/health`)).status).toBe(200);
      },
    );
  });

  it("still has the office after a restart, which is the point of keeping it", async () => {
    const dir = await onDisk();
    const env = { VO_STORAGE: `sqlite:${dir}/office.db`, VO_BLOBS: `file:${dir}/blobs` };

    await running(env, async (started) => {
      const made = await fetch(`${started.url}/offices`, {
        method: "POST",
        headers: { authorization: "Bearer sk-owner", "content-type": "application/json" },
        body: JSON.stringify({ name: "Northwind" }),
      });
      expect(made.status).toBe(201);
    });

    await running(env, async (started) => {
      const listed = (await (await get(`${started.url}/offices`)).json()) as {
        items: { name: string }[];
      };
      expect(listed.items.map((one) => one.name)).toEqual(["Northwind"]);
    });
  });
});

describe("a server told to use storage it cannot open", () => {
  it("says so plainly rather than listening on half an office", async () => {
    await expect(startServer(config({ VO_STORAGE: "postgres://nowhere/db" }))).rejects.toThrow(
      /adapter|postgres/i,
    );
  });
});
