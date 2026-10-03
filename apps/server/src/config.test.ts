import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "@vo/core";
import { DEFAULT_PORT, readServerConfig } from "./config.js";

const complete = {
  VO_API_TOKEN: "sk-owner",
};

const read = (overrides: Record<string, string | undefined> = {}) =>
  readServerConfig({ ...complete, ...overrides });

describe("what a server needs to be told", () => {
  it("starts from a token alone", () => {
    const config = unwrap(read());
    expect(config.token).toBe("sk-owner");
  });

  it("will not start without one, because that is an office anybody can read", () => {
    const result = readServerConfig({});
    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error[0]?.path).toBe("VO_API_TOKEN");
  });

  it("will not start on an empty one either", () => {
    expect(isErr(read({ VO_API_TOKEN: "   " }))).toBe(true);
  });
});

describe("where it listens", () => {
  it("picks a port, and a sensible one by default", () => {
    expect(unwrap(read()).port).toBe(DEFAULT_PORT);
    expect(unwrap(read({ VO_PORT: "8080" })).port).toBe(8080);
  });

  it("stays on the loopback unless told otherwise", () => {
    // Binding every interface by default would put an office on the network
    // the moment somebody ran it to try it out.
    expect(unwrap(read()).host).toBe("127.0.0.1");
    expect(unwrap(read({ VO_HOST: "0.0.0.0" })).host).toBe("0.0.0.0");
  });

  it("refuses a port that is not one, rather than listening somewhere random", () => {
    for (const port of ["-1", "nonsense", "99999", "1.5"]) {
      expect(isErr(read({ VO_PORT: port })), port).toBe(true);
    }
  });

  it("takes zero, which asks the machine to choose one", () => {
    // A real deployment names its port. Zero is for a test or a one-off run,
    // and the server says which port it actually got.
    expect(unwrap(read({ VO_PORT: "0" })).port).toBe(0);
  });
});

describe("where it keeps things", () => {
  it("keeps everything in memory unless told otherwise", () => {
    // A server run with no storage configured is somebody trying it out, and
    // it should work rather than ask for a database first.
    const config = unwrap(read());
    expect(config.storage.relational.href).toBe("memory:");
    expect(config.storage.blobs.href).toBe("memory:");
  });

  it("takes one url for the records and another for the documents", () => {
    const config = unwrap(
      read({ VO_STORAGE: "sqlite:///tmp/office.db", VO_BLOBS: "file:///tmp/blobs" }),
    );
    expect(config.storage.relational.protocol).toBe("sqlite:");
    expect(config.storage.blobs.protocol).toBe("file:");
  });

  it("points the records, the events and the vectors at the same place", () => {
    const config = unwrap(read({ VO_STORAGE: "sqlite:///tmp/office.db" }));
    expect(config.storage.events.href).toBe(config.storage.relational.href);
    expect(config.storage.vector.href).toBe(config.storage.relational.href);
  });

  it("leaves leader election in memory when the records move", () => {
    // Nothing in this server reads it — it is between workers — and sqlite
    // elects nobody, so following the records would stop a server that would
    // otherwise have run perfectly well.
    const config = unwrap(read({ VO_STORAGE: "sqlite:///tmp/office.db" }));
    expect(config.storage.coordination.href).toBe("memory:");
  });

  it("takes a coordination store of its own, for the day something needs one", () => {
    const config = unwrap(read({ VO_COORDINATION: "memory:?pool=shared" }));
    expect(config.storage.coordination.href).toBe("memory:?pool=shared");
  });

  it("refuses a coordination url that is not one", () => {
    expect(isErr(read({ VO_COORDINATION: "not a url" }))).toBe(true);
  });

  it("leaves documents in memory when only the records were moved", () => {
    // sqlite does not keep blobs, and silently pointing them at it would fail
    // later with a message about adapters rather than about configuration.
    expect(unwrap(read({ VO_STORAGE: "sqlite:///tmp/office.db" })).storage.blobs.href).toBe(
      "memory:",
    );
  });

  it("refuses a url that is not one", () => {
    expect(isErr(read({ VO_STORAGE: "not a url" }))).toBe(true);
    expect(isErr(read({ VO_BLOBS: "also not" }))).toBe(true);
  });
});

describe("a canvas to serve beside the office", () => {
  it("serves none unless it is given one", () => {
    // Every deployment that ran before this answers an API and nothing else.
    expect(unwrap(read()).webRoot).toBeNull();
  });

  it("takes the directory a built canvas is in", () => {
    expect(unwrap(read({ VO_WEB_ROOT: "/app/web" })).webRoot).toBe("/app/web");
  });

  it("treats an empty setting as none, since that is what a blank .env gives", () => {
    expect(unwrap(read({ VO_WEB_ROOT: "  " })).webRoot).toBeNull();
  });
});

describe("who may call it from a browser", () => {
  it("allows nobody by default, so it is reachable by servers only", () => {
    expect(unwrap(read()).allowedOrigins).toEqual([]);
  });

  it("takes a list", () => {
    expect(
      unwrap(read({ VO_ALLOWED_ORIGINS: "http://localhost:5173,https://office.test" }))
        .allowedOrigins,
    ).toEqual(["http://localhost:5173", "https://office.test"]);
  });

  it("ignores the spaces somebody will inevitably leave in", () => {
    expect(
      unwrap(read({ VO_ALLOWED_ORIGINS: " http://a.test , http://b.test " })).allowedOrigins,
    ).toEqual(["http://a.test", "http://b.test"]);
  });

  it("ignores an empty entry rather than allowing an empty origin", () => {
    expect(unwrap(read({ VO_ALLOWED_ORIGINS: "http://a.test,," })).allowedOrigins).toEqual([
      "http://a.test",
    ]);
  });
});

describe("saying everything that is wrong at once", () => {
  it("reports every problem, not only the first", () => {
    // A server that failed one line at a time would take four restarts to
    // configure, and each restart looks like a different fault.
    const result = readServerConfig({ VO_PORT: "nonsense", VO_STORAGE: "not a url" });
    expect(isErr(result) && result.error.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the key that opens this office's vault", () => {
  it("is taken from the environment, which is the only place it may live", () => {
    expect(unwrap(read({ VO_VAULT_KEY: "a".repeat(44) })).vaultKey).toBe("a".repeat(44));
  });

  it("is null when nobody set one, so the office refuses to keep a pasted key", () => {
    // Said rather than guessed: an office that invented a key would encrypt
    // every secret under something nobody could reproduce after a restart.
    expect(unwrap(read({})).vaultKey).toBeNull();
  });
});
