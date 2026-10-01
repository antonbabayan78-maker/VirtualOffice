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
