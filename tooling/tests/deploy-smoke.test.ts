/**
 * The deploy kit, booted.
 *
 * `deploy.test.ts` reads the files; this one runs them. It builds the image,
 * starts an office on its own volume, makes an office with a department, a
 * person and a piece of work in it, puts a worker on it, and waits for the work
 * to be done — then stops everything and throws the volume away.
 *
 * **It is opt-in, and it never passes quietly.** Building an image is minutes,
 * which has no business in the loop somebody runs on every save, so it waits to
 * be asked: `VO_DOCKER_SMOKE=1`, which the deploy job in CI sets and
 * `ci.test.ts` insists on. Asked for and unable to run, it fails and says why —
 * a smoke test that skips itself on the machine that was meant to run it is
 * worse than no smoke test, because it reports green.
 *
 * The office publishes no port, which is the point of the compose file, so this
 * adds one through an override rather than weakening the file it is testing.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const COMPOSE = join(ROOT, "deploy", "compose.yaml");
const PROJECT = "vo-smoke";
const TOKEN = "sk-smoke-test";

/** Long enough to build an image on a cold cache. */
const BOOT = 600_000;

const asked = process.env["VO_DOCKER_SMOKE"] === "1";

function dockerVersion(): string | null {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

/** An override that publishes the office on a port this test can reach. */
function overrideFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "vo-smoke-"));
  const path = join(dir, "smoke.yaml");
  writeFileSync(
    path,
    ["services:", "  office:", "    ports:", '      - "127.0.0.1:3188:3100"', ""].join("\n"),
  );
  return path;
}

const OVERRIDE = overrideFile();
const OFFICE_URL = "http://127.0.0.1:3188";

function compose(args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE, "-f", OVERRIDE, "-p", PROJECT, ...args],
    {
      encoding: "utf8",
      // Caddy is left out of every call: it would ask for a certificate and
      // want ports 80 and 443 on whatever machine this is running on.
      env: {
        ...process.env,
        VO_DOMAIN: "localhost",
        VO_API_TOKEN: TOKEN,
        VO_OFFICE_ID: "",
        VO_DRY_RUN: "1",
        VO_ALLOWED_ORIGINS: "",
        ...env,
      },
      timeout: BOOT,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} failed (${String(result.status)}):\n${result.stderr}`,
    );
  }
  return result.stdout;
}

const call = async (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${OFFICE_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  });

const post = async (path: string, body: unknown): Promise<Record<string, string>> => {
  const response = await call(path, { method: "POST", body: JSON.stringify(body) });
  const text = await response.text();
  if (response.status !== 201) throw new Error(`POST ${path} → ${String(response.status)} ${text}`);
  return JSON.parse(text) as Record<string, string>;
};

/** Waits for something to become true, or says what it was still seeing. */
async function until(
  what: string,
  check: () => Promise<boolean>,
  { tries = 60, every = 1000 } = {},
): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((wake) => setTimeout(wake, every));
  }
  throw new Error(`gave up waiting for ${what}${last === "" ? "" : `: ${last}`}`);
}

/**
 * An MCP server as one argument to node, so the kit's own images can run it
 * without anything being mounted or built in. The README tells a deployment to
 * put the server in the image; this proves the image can run one at all, which
 * is the part no unit test can.
 */
const POST_ROOM = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf("\\n");
  while (at >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    const answer = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "initialize")
      answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "post", version: "1" } });
    else if (message.method === "tools/list")
      answer({ tools: [{ name: "send_email", description: "Send an email.", inputSchema: { type: "object", properties: { to: { type: "string" } } } }] });
    else if (message.method === "tools/call")
      answer({ content: [{ type: "text", text: "sent" }] });
    else if (message.id !== undefined) answer({});
  }
});
`;

describe("docker, before anything else", () => {
  it("is here when this test was asked for", () => {
    if (!asked) {
      console.warn("deploy smoke test skipped: set VO_DOCKER_SMOKE=1 to boot the kit");
      return;
    }
    expect(dockerVersion(), "VO_DOCKER_SMOKE was set but docker is not running").not.toBeNull();
  });
});

describe.skipIf(!asked || dockerVersion() === null)("an office, deployed", () => {
  afterAll(() => {
    // -v because the volume is the office: a smoke test that left one behind
    // would be a smoke test that passed on yesterday's data.
    spawnSync("docker", ["compose", "-f", COMPOSE, "-f", OVERRIDE, "-p", PROJECT, "down", "-v"], {
      encoding: "utf8",
      env: { ...process.env, VO_DOMAIN: "localhost", VO_API_TOKEN: TOKEN },
      timeout: BOOT,
    });
  });

  it(
    "boots, and answers that it is well",
    async () => {
      compose(["up", "-d", "--build", "office"]);
      await until("the office to answer", async () => (await fetch(`${OFFICE_URL}/health`)).ok);

      expect((await fetch(`${OFFICE_URL}/health`)).status).toBe(200);
    },
    BOOT,
  );

  it(
    "runs a sample office: work arrives, a worker does it, it is done",
    async () => {
      const office = await post("/offices", { name: "Northwind Studio" });
      const department = await post(`/offices/${office["id"] ?? ""}/departments`, {
        name: "Design",
        color: "#7c5cff",
        position: { x: 0, y: 0 },
        reviewPolicy: { kind: "direct" },
      });
      const employee = await post(`/offices/${office["id"] ?? ""}/employees`, {
        name: "Iris",
        role: "Designer",
        color: "#00aa66",
        department: department["id"] ?? "",
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      const task = await post(`/offices/${office["id"] ?? ""}/tasks`, {
        departmentId: department["id"] ?? "",
        title: "Draft the launch note",
        assigneeId: employee["id"] ?? "",
      });

      // The worker is told which office only now, because until one exists
      // there is no id to tell it — which is exactly what a fresh deployment
      // does, and why the README says so.
      compose(["up", "-d", "--build", "worker"], { VO_OFFICE_ID: office["id"] ?? "" });

      await until(
        "the work to be done",
        async () => {
          const response = await call(`/tasks/${task["id"] ?? ""}`);
          const current = (await response.json()) as { status: string };
          return current.status === "done";
        },
        { tries: 90 },
      );
    },
    BOOT,
  );

  it(
    "serves the canvas, and asks a browser to sign in to it",
    async () => {
      const page = await fetch(`${OFFICE_URL}/`, { headers: { accept: "text/html" } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<div id="root"');

      // The page is open and the office behind it is not.
      expect((await fetch(`${OFFICE_URL}/offices`)).status).toBe(401);

      const refused = await fetch(`${OFFICE_URL}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "sk-nonsense" }),
      });
      expect(refused.status).toBe(401);

      const signedIn = await fetch(`${OFFICE_URL}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN }),
      });
      expect(signedIn.status).toBe(200);
      const cookie = signedIn.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("vo_session=");
      expect(cookie).toMatch(/HttpOnly/i);

      // And that cookie is a credential the office accepts.
      const asBrowser = await fetch(`${OFFICE_URL}/offices`, {
        headers: { cookie: cookie.split(";")[0] ?? "" },
      });
      expect(asBrowser.status).toBe(200);
    },
    BOOT,
  );

  it(
    "holds a tool that acts until a person answers, and then runs it",
    async () => {
      const listed = (await (await call("/offices")).json()) as { items: { id: string }[] };
      const officeId = listed.items[0]?.id ?? "";
      const rooms = (await (await call(`/offices/${officeId}/departments`)).json()) as {
        items: { id: string }[];
      };
      const departmentId = rooms.items[0]?.id ?? "";
      const people = (await (await call(`/offices/${officeId}/employees`)).json()) as {
        items: { id: string }[];
      };
      const employeeId = people.items[0]?.id ?? "";

      // An MCP connector whose server is a command these images can run.
      const connector = await post(`/offices/${officeId}/connectors`, {
        kind: "mcp",
        name: "post",
        tools: [],
        config: { command: "node", args: ["-e", POST_ROOM] },
      });

      // The office asks the server what it offers, which means spawning it.
      const discovered = await call(`/connectors/${connector["id"] ?? ""}/discover`, {
        method: "POST",
        // An empty body with a JSON content-type is a 400 from Fastify itself,
        // which is a confusing way to fail a test about something else.
        body: "{}",
      });
      expect(discovered.status).toBe(200);
      expect(((await discovered.json()) as { tools: string[] }).tools).toEqual(["send_email"]);

      await call(`/departments/${departmentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          toolGrants: [{ connectorId: connector["id"] ?? "", tool: "send_email" }],
        }),
      });

      const task = await post(`/offices/${officeId}/tasks`, {
        departmentId,
        title: "Tell the customer their order shipped",
        assigneeId: employeeId,
      });
      const taskId = task["id"] ?? "";

      // The worker reaches the tool and stops before it.
      await until(
        "the work to be waiting for a person",
        async () => {
          const current = (await (await call(`/tasks/${taskId}`)).json()) as { status: string };
          return current.status === "blocked";
        },
        { tries: 90 },
      );

      const state = (await (await call(`/tasks/${taskId}/run-checkpoint`)).json()) as {
        checkpoint: { pendingApproval?: { items: { key: string; gates: string[] }[] } } | null;
      };
      const held = state.checkpoint?.pendingApproval?.items[0];
      expect(held?.gates).toEqual(["external_send"]);

      // Answered the way the README says to answer one.
      const decided = await call(`/tasks/${taskId}/events`, {
        method: "POST",
        body: JSON.stringify({
          type: "call_decided",
          key: held?.key ?? "",
          decision: "approved",
          decidedBy: "the owner",
        }),
      });
      expect(decided.status).toBe(200);

      await until(
        "the work to finish once it was allowed to",
        async () => {
          const current = (await (await call(`/tasks/${taskId}`)).json()) as { status: string };
          return current.status === "done";
        },
        { tries: 90 },
      );
    },
    BOOT,
  );

  it(
    "still has the office after the containers are replaced",
    async () => {
      // The volume is the whole point of the kit: everything else in it can be
      // rebuilt from the repository.
      compose(["down"]);
      compose(["up", "-d", "office"]);
      await until(
        "the office to answer again",
        async () => (await fetch(`${OFFICE_URL}/health`)).ok,
      );

      const listed = (await (await call("/offices")).json()) as { items: { name: string }[] };
      expect(listed.items.map((one) => one.name)).toEqual(["Northwind Studio"]);
    },
    BOOT,
  );
});
