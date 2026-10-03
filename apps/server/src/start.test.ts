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

describe("an office that can study how somebody writes", () => {
  const send = (url: string, method: string, body?: unknown) =>
    fetch(url, {
      method,
      headers: { authorization: "Bearer sk-owner", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("asks a service of its own, and keeps the card it answers with", async () => {
    // The wiring no unit test can prove: a real office, a real service row, and
    // a server answering the way every one of them does.
    const asked: { system: string; user: string }[] = [];
    const listener = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        if ((request.url ?? "").endsWith("/models")) {
          response.end(JSON.stringify({ data: [{ id: "qwen3-coder" }] }));
          return;
        }
        const sent = JSON.parse(body) as {
          messages: { role: string; content: string }[];
        };
        asked.push({
          system: sent.messages.find((one) => one.role === "system")?.content ?? "",
          user: sent.messages.find((one) => one.role === "user")?.content ?? "",
        });
        response.end(
          JSON.stringify({
            id: "chatcmpl-1",
            model: "qwen3-coder",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "Opens with the first name." },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = (listener.address() as { port: number }).port;

    try {
      await running({}, async (started) => {
        const office = await send(`${started.url}/offices`, "POST", { name: "Northwind" });
        const officeId = ((await office.json()) as { id: string }).id;
        const department = await send(`${started.url}/offices/${officeId}/departments`, "POST", {
          name: "Support",
          color: "#3366ff",
          position: { x: 0, y: 0 },
        });
        const departmentId = ((await department.json()) as { id: string }).id;
        await send(`${started.url}/offices/${officeId}/services`, "POST", {
          kind: "openai-compatible",
          name: "workshop",
          baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        });
        const hired = await send(`${started.url}/offices/${officeId}/employees`, "POST", {
          name: "Sam",
          role: "Clerk",
          color: "#00aa66",
          department: departmentId,
          llm: { provider: "workshop", model: "qwen3-coder" },
          understudy: { person: "Anna Petrova", recordedBy: "ignored" },
        });
        const employeeId = ((await hired.json()) as { id: string }).id;

        await send(`${started.url}/offices/${officeId}/documents`, "POST", {
          ownerKind: "employee",
          ownerId: employeeId,
          tray: "in",
          name: "reply.txt",
          mediaType: "text/plain",
          contentBase64: Buffer.from("Hi Tom,\n\nSorted — goes out today.\n\nAnna").toString(
            "base64",
          ),
        });

        const studied = await send(`${started.url}/employees/${employeeId}/study`, "POST", {});

        expect(studied.status).toBe(200);
        const employee = (await studied.json()) as {
          understudy: { card: string; cardFromSamples: number };
        };
        expect(employee.understudy.card).toBe("Opens with the first name.");
        expect(employee.understudy.cardFromSamples).toBe(1);
        // It studied the right person, and was given the writing to study.
        expect(asked[0]?.system).toContain("Anna Petrova");
        expect(asked[0]?.user).toContain("Sorted — goes out today.");
      });
    } finally {
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
    }
  });

  it("says it cannot when the office has no service and no key", async () => {
    await running({}, async (started) => {
      const office = await send(`${started.url}/offices`, "POST", { name: "Northwind" });
      const officeId = ((await office.json()) as { id: string }).id;
      const department = await send(`${started.url}/offices/${officeId}/departments`, "POST", {
        name: "Support",
        color: "#3366ff",
        position: { x: 0, y: 0 },
      });
      const departmentId = ((await department.json()) as { id: string }).id;
      const hired = await send(`${started.url}/offices/${officeId}/employees`, "POST", {
        name: "Sam",
        role: "Clerk",
        color: "#00aa66",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
        understudy: { person: "Anna Petrova", recordedBy: "ignored" },
      });
      const employeeId = ((await hired.json()) as { id: string }).id;
      await send(`${started.url}/offices/${officeId}/documents`, "POST", {
        ownerKind: "employee",
        ownerId: employeeId,
        tray: "in",
        name: "reply.txt",
        mediaType: "text/plain",
        contentBase64: Buffer.from("Hi Tom,").toString("base64"),
      });

      const studied = await send(`${started.url}/employees/${employeeId}/study`, "POST", {});

      expect(studied.status).toBe(502);
      expect(((await studied.json()) as { error: string }).error).toMatch(/no model|key|service/i);
    });
  });
});

describe("an office that looks back over its own people", () => {
  const send = (url: string, method: string, body?: unknown) =>
    fetch(url, {
      method,
      headers: { authorization: "Bearer sk-owner", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("reads the record on the office's own service and writes a proposal down", async () => {
    // The wiring no unit test can prove: a real office, a real service row, a
    // real record of work that went back, and a server answering the way every
    // one of them does.
    const asked: string[] = [];
    /** The work the office will have recorded by the time it is asked. */
    let theWork = "unknown";
    const listener = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        if ((request.url ?? "").endsWith("/models")) {
          response.end(JSON.stringify({ data: [{ id: "qwen3-coder" }] }));
          return;
        }
        asked.push(body);
        // A model names the work it was shown; this one names the piece the
        // office actually recorded, which is what makes its evidence real.
        const named = theWork;
        response.end(
          JSON.stringify({
            id: "chatcmpl-1",
            model: "qwen3-coder",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "propose_change",
                        arguments: JSON.stringify({
                          instructions: "Always check the order number before replying.",
                          because: "It went back twice for want of an order number.",
                          evidence: [{ taskId: named, what: "went back twice" }],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = (listener.address() as { port: number }).port;

    try {
      await running({}, async (started) => {
        const office = await send(`${started.url}/offices`, "POST", { name: "Northwind" });
        const officeId = ((await office.json()) as { id: string }).id;
        // A room whose manager reviews, so work can actually be sent back —
        // which is the record a retrospective reads.
        const department = await send(`${started.url}/offices/${officeId}/departments`, "POST", {
          name: "Support",
          color: "#3366ff",
          position: { x: 0, y: 0 },
          reviewPolicy: { kind: "manager", maxIterations: 5 },
        });
        const departmentId = ((await department.json()) as { id: string }).id;
        await send(`${started.url}/offices/${officeId}/services`, "POST", {
          kind: "openai-compatible",
          name: "workshop",
          baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        });
        const boss = await send(`${started.url}/offices/${officeId}/employees`, "POST", {
          name: "Grace",
          role: "Manager",
          color: "#ff8800",
          department: departmentId,
          llm: { provider: "workshop", model: "qwen3-coder" },
        });
        const bossId = ((await boss.json()) as { id: string }).id;
        const hired = await send(`${started.url}/offices/${officeId}/employees`, "POST", {
          name: "Sam",
          role: "Clerk",
          color: "#00aa66",
          department: departmentId,
          llm: { provider: "workshop", model: "qwen3-coder" },
          supervisorId: bossId,
          selfImprovement: true,
        });
        const employeeId = ((await hired.json()) as { id: string }).id;

        // A piece of work that went back, which is the record to read.
        const made = await send(`${started.url}/offices/${officeId}/tasks`, "POST", {
          departmentId,
          title: "Tell the customer",
          assigneeId: employeeId,
        });
        const taskId = ((await made.json()) as { id: string }).id;
        theWork = taskId;
        for (const event of [
          { type: "start", actorId: employeeId },
          { type: "submit", actorId: employeeId, artifacts: ["a reply"] },
          { type: "request_changes", actorId: bossId, reason: "no order number" },
          { type: "submit", actorId: employeeId, artifacts: ["a reply"] },
          { type: "request_changes", actorId: bossId, reason: "no order number" },
          { type: "submit", actorId: employeeId, artifacts: ["a reply"] },
          { type: "approve", actorId: bossId },
        ]) {
          const moved = await send(`${started.url}/tasks/${taskId}/events`, "POST", event);
          expect(moved.status, `${event.type}: ${await moved.clone().text()}`).toBe(200);
        }

        const looked = await send(
          `${started.url}/employees/${employeeId}/retrospective`,
          "POST",
          {},
        );

        expect(looked.status).toBe(200);
        const body: unknown = await looked.json();
        expect(body).not.toMatchObject({ proposed: false });
        const proposal = body as {
          because: string;
          changes: { after: string }[];
          evidence: { taskId: string }[];
        };
        expect(proposal.changes[0]?.after).toBe("Always check the order number before replying.");
        expect(proposal.because).toContain("order number");
        // It was given the record, and its evidence points at real work.
        expect(asked[0]).toContain("no order number");
        expect(proposal.evidence[0]?.taskId).toBe(taskId);
      });
    } finally {
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
    }
  });
});
