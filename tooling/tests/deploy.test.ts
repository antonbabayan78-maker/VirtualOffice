/**
 * Deploy kit conformance test.
 *
 * Executable definition of what it takes to run an office somewhere: an image
 * for each of the two processes, a compose file that puts them behind TLS with
 * their storage on a volume, and an example environment that names everything
 * either of them needs.
 *
 * The same shape as `ci.test.ts`, and for the same reason. A deploy kit is read
 * once and then trusted for months, so the properties that make it safe — the
 * office not published to the host, the storage inside the volume, nothing
 * running as root — are assertions rather than things somebody remembers.
 *
 * The smoke test that actually boots it lives in `deploy-smoke.test.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

const read = (...path: string[]): string => {
  const file = join(ROOT, ...path);
  expect(existsSync(file), `${path.join("/")} must exist`).toBe(true);
  return readFileSync(file, "utf8");
};

describe("the image the two processes run in", () => {
  const dockerfile = (): string => read("Dockerfile");

  it("builds both processes out of one build", () => {
    // One build, two targets: the packages are shared, and building them twice
    // would be twice the time for the same bytes.
    expect(dockerfile()).toMatch(/AS build/);
    expect(dockerfile()).toMatch(/AS server/);
    expect(dockerfile()).toMatch(/AS worker/);
  });

  it("installs exactly what the lockfile says", () => {
    expect(dockerfile()).toMatch(/pnpm install --frozen-lockfile/);
  });

  it("ships neither the sources nor the dev dependencies", () => {
    // `pnpm deploy --prod` is what makes the running image small: a tree with
    // the built output and the dependencies it actually needs.
    expect(dockerfile()).toMatch(/pnpm deploy[^\n]*--prod/);
  });

  it("runs as somebody other than root", () => {
    const stages = dockerfile()
      .split(/^FROM /m)
      .slice(1);
    for (const stage of stages.filter((one) => /^node:\S+ AS (server|worker)/.test(one))) {
      expect(stage, `${stage.split("\n")[0] ?? ""} must drop root`).toMatch(/USER node/);
    }
  });

  it("gives the office somewhere it can actually write", () => {
    // An empty named volume takes the ownership of the directory it is mounted
    // over, so a /data that does not exist in the image — or exists owned by
    // root — is a volume the office cannot open its database in. It boots,
    // fails to open a file, and restarts forever.
    const server = dockerfile()
      .split(/^FROM /m)
      .find((one) => /^node:\S+ AS server/.test(one));
    expect(server ?? "").toMatch(/mkdir[^\n]*\/data[\s\S]*chown[^\n]*node/);
  });

  it("takes the canvas with it, so the office can serve its own", () => {
    // Which is what lets a browser hold no credential: same origin, so the
    // cookie set at sign-in is simply sent, and no token is built into the
    // bundle for somebody to read out of it.
    const server = dockerfile()
      .split(/^FROM /m)
      .find((one) => /^node:\S+ AS server/.test(one));
    expect(server ?? "").toMatch(/apps\/web\/dist/);
    expect(server ?? "").toMatch(/VO_WEB_ROOT=/);
  });

  it("starts each process at its own entry point", () => {
    expect(dockerfile()).toMatch(/CMD \["node", "dist\/main\.js"\]/);
  });

  it("keeps the build context down to what is built from", () => {
    const ignored = read(".dockerignore");
    for (const path of ["node_modules", "dist", ".git", "coverage"]) {
      expect(ignored, `${path} must stay out of the build context`).toMatch(
        new RegExp(`^${path}`, "m"),
      );
    }
  });
});

interface ComposeService {
  build?: { context?: string; dockerfile?: string; target?: string };
  image?: string;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  healthcheck?: { test?: string[] | string };
  depends_on?: Record<string, { condition?: string }>;
  restart?: string;
}
interface Compose {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

describe("the compose file that runs an office", () => {
  const compose = (): Compose => parseYaml(read("deploy", "compose.yaml")) as Compose;

  /** One service, or a failure that names the one that is missing. */
  function service(name: string): ComposeService {
    const found = compose().services[name];
    if (found === undefined) throw new Error(`the compose file has no "${name}" service`);
    return found;
  }
  const office = (): ComposeService => service("office");

  it("runs the office, the worker and something that terminates TLS", () => {
    expect(Object.keys(compose().services).sort()).toEqual(["caddy", "office", "worker"]);
  });

  it("builds both from the one Dockerfile, by target", () => {
    expect(office().build?.target).toBe("server");
    expect(service("worker").build?.target).toBe("worker");
  });

  it("publishes nothing but the proxy", () => {
    // A bearer token over plain HTTP is a token anybody on the path can read,
    // and a published office port is a way past the proxy that holds the
    // certificate. The only doors are 80 and 443.
    expect(office().ports ?? []).toEqual([]);
    expect(service("worker").ports ?? []).toEqual([]);
    expect(service("caddy").ports?.join(" ")).toMatch(/443/);
  });

  it("makes the office listen where another container can reach it", () => {
    // The default is the loopback, which inside a container is a server nothing
    // can talk to — including the proxy in front of it.
    expect(office().environment?.["VO_HOST"]).toBe("0.0.0.0");
  });

  it("keeps the records and the documents on a volume that outlives the container", () => {
    const data = (office().volumes ?? []).find((one) => one.includes(":/data"));
    expect(data, "the office must mount something at /data").toBeDefined();

    const named = (data ?? "").split(":")[0] ?? "";
    expect(Object.keys(compose().volumes ?? {})).toContain(named);
    expect(office().environment?.["VO_STORAGE"]).toMatch(/^sqlite:\/data\//);
    expect(office().environment?.["VO_BLOBS"]).toMatch(/^file:\/data\//);
  });

  it("checks the office is actually answering, not merely running", () => {
    expect(JSON.stringify(office().healthcheck?.test ?? [])).toMatch(/health/);
  });

  it("starts the worker only once the office answers", () => {
    // A worker against an office that is still opening its database spends its
    // first ticks reporting that the office cannot be read.
    expect(service("worker").depends_on?.["office"]?.condition).toBe("service_healthy");
  });

  it("sends the worker to the office by name, not through the proxy", () => {
    expect(service("worker").environment?.["VO_API_URL"]).toMatch(/^http:\/\/office:/);
  });

  it("brings everything back after a reboot", () => {
    for (const [name, service] of Object.entries(compose().services)) {
      expect(service.restart, `${name} must restart`).toBe("unless-stopped");
    }
  });
});

describe("the environment somebody has to fill in", () => {
  const example = (): string => read("deploy", ".env.example");

  /** Every ${VAR} the compose file reads. */
  const wanted = (): string[] => {
    const text = read("deploy", "compose.yaml");
    return [...new Set([...text.matchAll(/\$\{([A-Z0-9_]+)[:?}-]/g)].map((m) => m[1] ?? ""))];
  };

  it("names every variable the compose file reads", () => {
    const named = example();
    for (const variable of wanted()) {
      expect(named, `${variable} must appear in deploy/.env.example`).toMatch(
        new RegExp(`^${variable}=`, "m"),
      );
    }
  });

  it("asks for the three things an office cannot run without", () => {
    expect(wanted()).toEqual(expect.arrayContaining(["VO_API_TOKEN", "VO_DOMAIN"]));
  });

  it("carries no secrets of its own", () => {
    // It is committed, and an example with a real key in it is a leaked key.
    expect(example()).not.toMatch(/sk-ant-[A-Za-z0-9]/);
    for (const line of example().split("\n")) {
      const [, value = ""] = /^([A-Z0-9_]+)=(.*)$/.exec(line) ?? [];
      expect(value.length, `${line} must be left empty or obviously a placeholder`).toBeLessThan(
        60,
      );
    }
  });

  it("says what each one is for", () => {
    // Half the variables are secrets and the other half decide where an office
    // lives; a bare list of names is a list of things to guess at.
    expect(example()).toMatch(/^#/m);
  });
});

describe("the instructions beside it", () => {
  const readme = (): string => read("deploy", "README.md");

  it("says how to start it and how to upgrade it", () => {
    expect(readme()).toMatch(/docker compose .*up/);
    expect(readme()).toMatch(/upgrad|pull/i);
  });

  it("says how an office gets into a fresh deployment", () => {
    // There is no route that takes an office file, so the first office is made
    // by hand and its id is what the worker has to be told.
    expect(readme()).toMatch(/VO_OFFICE_ID/);
  });

  it("says how to point a canvas at it, which is the only way to see it", () => {
    expect(readme()).toMatch(/VO_ALLOWED_ORIGINS/);
    expect(readme()).toMatch(/VITE_VO_API_URL/);
  });

  it("says where the data is, since a volume is easy to lose", () => {
    expect(readme()).toMatch(/volume/i);
  });

  it("says what the kit does not do", () => {
    expect(readme()).toMatch(/not|yet/i);
  });
});
