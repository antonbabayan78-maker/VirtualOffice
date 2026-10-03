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

describe("a started server asking a connector what it offers", () => {
  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer sk-owner", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /**
   * Proof that the real discoverer is wired, without spawning anything: the
   * only way this answer can be produced is by actually trying to run the
   * command the connector names.
   */
  it("really tries, and says why it could not", async () => {
    await running({}, async (started) => {
      const office = (await (
        await post(`${started.url}/offices`, { name: "Northwind" })
      ).json()) as {
        id: string;
      };
      const connector = (await (
        await post(`${started.url}/offices/${office.id}/connectors`, {
          kind: "mcp",
          name: "acme",
          tools: [],
          config: { command: "/definitely/not/a/program" },
        })
      ).json()) as { id: string };

      const answer = await post(`${started.url}/connectors/${connector.id}/discover`, {});

      expect(answer.status).toBe(502);
      expect(((await answer.json()) as { error: string }).error).toMatch(/not\/a\/program|ENOENT/);
    });
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

describe("an office that keeps a key for a service", () => {
  const send = (url: string, method: string, body?: unknown) =>
    fetch(url, {
      method,
      headers: { authorization: "Bearer sk-owner", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** A 32-byte key, as the vault wants it. */
  const VAULT_KEY = Buffer.alloc(32, 7).toString("base64");

  const aService = async (url: string, name = "workshop", baseUrl = "http://localhost:1/v1") => {
    const office = await send(`${url}/offices`, "POST", { name: "Northwind" });
    const officeId = ((await office.json()) as { id: string }).id;
    const created = await send(`${url}/offices/${officeId}/services`, "POST", {
      kind: "openai-compatible",
      name,
      baseUrl,
    });
    return { officeId, id: ((await created.json()) as { id: string }).id };
  };

  it("keeps a pasted key where the blobs are, and hands it back to a token", async () => {
    await running({ VO_VAULT_KEY: VAULT_KEY }, async (started) => {
      const { id } = await aService(started.url);

      const set = await send(`${started.url}/services/${id}/credential`, "PUT", {
        apiKey: "sk-live-1",
      });

      expect(set.status).toBe(200);
      const service = (await set.json()) as { secretRef: string | null };
      expect(service.secretRef).toMatch(/^vault:\/\//);
      // Through the real vault, encrypted and read back again.
      const read = await get(`${started.url}/services/${id}/credential`);
      expect(await read.json()).toEqual({ apiKey: "sk-live-1" });
    });
  });

  it("refuses to keep one without a key of its own, rather than storing it in the clear", async () => {
    await running({}, async (started) => {
      const { id } = await aService(started.url);

      const refused = await send(`${started.url}/services/${id}/credential`, "PUT", {
        apiKey: "sk-live-1",
      });

      expect(refused.status).toBe(501);
      expect(((await refused.json()) as { error: string }).error).toMatch(/variable/i);
    });
  });

  it("asks a real service which models it has", async () => {
    // The office's own `discoverModels`, against a server that answers like
    // every one of them does: this is the wiring no unit test can prove.
    const asked: string[] = [];
    const listener = createServer((request, response) => {
      asked.push(`${request.method ?? ""} ${request.url ?? ""}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "qwen3-coder" }, { id: "llama3" }] }));
    });
    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = (listener.address() as { port: number }).port;

    try {
      await running({}, async (started) => {
        const { id } = await aService(
          started.url,
          "workshop",
          `http://127.0.0.1:${String(port)}/v1`,
        );

        const found = await send(`${started.url}/services/${id}/discover`, "POST", {});

        expect(found.status).toBe(200);
        const service = (await found.json()) as { models: { id: string }[] };
        expect(service.models.map((model) => model.id)).toEqual(["qwen3-coder", "llama3"]);
        expect(asked).toEqual(["GET /v1/models"]);
      });
    } finally {
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
    }
  });

  it("says why a service could not be asked, because somebody is waiting", async () => {
    await running({}, async (started) => {
      // Nothing is listening on port 1.
      const { id } = await aService(started.url, "workshop", "http://127.0.0.1:1/v1");

      const failed = await send(`${started.url}/services/${id}/discover`, "POST", {});

      expect(failed.status).toBe(502);
      expect(((await failed.json()) as { error: string }).error.length).toBeGreaterThan(0);
    });
  });
});
