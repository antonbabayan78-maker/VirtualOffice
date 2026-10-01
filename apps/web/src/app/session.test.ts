import { describe, expect, it } from "vitest";
import type { ApiClient } from "@vo/api-client";
import type { Office } from "@vo/core";
import { resolveSession, type SessionDeps } from "./session.js";

const office = (id: string, name: string): Office =>
  ({ id, name, createdAt: new Date("2026-10-02T09:00:00Z") }) as unknown as Office;

const served = { baseUrl: "https://office.test", streamUrl: "wss://office.test/ws" };

/** A client that answers `listOffices` and nothing else. */
const api = (answer: Awaited<ReturnType<ApiClient["listOffices"]>>): ApiClient =>
  ({ listOffices: () => Promise.resolve(answer) }) as unknown as ApiClient;

const deps = (overrides: Partial<SessionDeps> = {}): SessionDeps => ({
  env: {},
  origin: "https://office.test",
  probe: () => Promise.resolve(served),
  createClient: () => api({ ok: true, value: [office("office-1", "Northwind")] }),
  remembered: () => null,
  ...overrides,
});

describe("a canvas that was given a token", () => {
  it("talks to the office it was configured for, as it always did", async () => {
    const session = await resolveSession(
      deps({
        env: {
          VITE_VO_API_URL: "https://elsewhere.test",
          VITE_VO_API_TOKEN: "sk-owner",
          VITE_VO_OFFICE_ID: "office-9",
        },
      }),
    );

    expect(session.kind).toBe("ready");
    if (session.kind === "ready") {
      expect(session.config.baseUrl).toBe("https://elsewhere.test");
      expect(session.config.token).toBe("sk-owner");
      expect(session.config.officeId).toBe("office-9");
    }
  });

  it("does not go asking its own address when it already knows one", async () => {
    let probed = false;
    await resolveSession(
      deps({
        env: {
          VITE_VO_API_URL: "https://elsewhere.test",
          VITE_VO_API_TOKEN: "sk-owner",
          VITE_VO_OFFICE_ID: "office-9",
        },
        probe: () => {
          probed = true;
          return Promise.resolve(served);
        },
      }),
    );
    expect(probed).toBe(false);
  });
});

describe("a canvas with no office anywhere", () => {
  it("falls back to the sample office, so it still works", async () => {
    // Which is what `pnpm dev` with nothing running has always done.
    const session = await resolveSession(deps({ probe: () => Promise.resolve(null) }));
    expect(session.kind).toBe("sample");
  });
});

describe("a canvas the office served", () => {
  it("asks for the token when nobody is signed in", async () => {
    const session = await resolveSession(
      deps({ createClient: () => api({ ok: false, kind: "unauthorized" }) }),
    );

    expect(session.kind).toBe("signIn");
    if (session.kind === "signIn") expect(session.address).toEqual(served);
  });

  it("opens the only office there is, without asking", async () => {
    const session = await resolveSession(deps());

    expect(session.kind).toBe("ready");
    if (session.kind === "ready") {
      expect(session.config.officeId).toBe("office-1");
      expect(session.config.baseUrl).toBe("https://office.test");
      // The whole point: nothing in the page holds a credential.
      expect(session.config.token).toBeUndefined();
    }
  });

  it("asks which one when there are several", async () => {
    const session = await resolveSession(
      deps({
        createClient: () =>
          api({ ok: true, value: [office("office-1", "Northwind"), office("office-2", "Acme")] }),
      }),
    );

    expect(session.kind).toBe("choose");
    if (session.kind === "choose") expect(session.offices).toHaveLength(2);
  });

  it("opens the one it was told to open last time", async () => {
    const session = await resolveSession(
      deps({
        createClient: () =>
          api({ ok: true, value: [office("office-1", "Northwind"), office("office-2", "Acme")] }),
        remembered: () => "office-2",
      }),
    );

    expect(session.kind === "ready" && session.config.officeId).toBe("office-2");
  });

  it("asks again when the office it remembers has gone", async () => {
    const session = await resolveSession(
      deps({
        createClient: () =>
          api({ ok: true, value: [office("office-1", "Northwind"), office("office-2", "Acme")] }),
        remembered: () => "office-gone",
      }),
    );
    expect(session.kind).toBe("choose");
  });

  it("offers to make one when the office has none, which a fresh deployment has not", async () => {
    const session = await resolveSession(
      deps({ createClient: () => api({ ok: true, value: [] }) }),
    );

    expect(session.kind).toBe("choose");
    if (session.kind === "choose") expect(session.offices).toEqual([]);
  });

  it("says what went wrong rather than showing an empty canvas", async () => {
    const session = await resolveSession(
      deps({
        createClient: () => api({ ok: false, kind: "transport", message: "unreachable" }),
      }),
    );

    expect(session.kind).toBe("signIn");
    if (session.kind === "signIn") expect(session.problem).toMatch(/unreachable/);
  });

  it("says nothing is wrong when it is simply not signed in", async () => {
    // "Please sign in" is not an error, and showing one would make the ordinary
    // first visit look broken.
    const session = await resolveSession(
      deps({ createClient: () => api({ ok: false, kind: "unauthorized" }) }),
    );
    expect(session.kind === "signIn" && session.problem).toBeNull();
  });
});
