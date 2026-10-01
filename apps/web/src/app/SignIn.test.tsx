import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { ApiClient } from "@vo/api-client";
import type { Office } from "@vo/core";
import { ThemeProvider } from "../ui/theme.js";
import { App } from "./App.js";
import type { OfficeAddress } from "../api/config.js";

const served: OfficeAddress = {
  baseUrl: "http://office.test",
  streamUrl: "ws://office.test/ws",
};

const office = (id: string, name: string): Office =>
  ({ id, name, createdAt: new Date("2026-10-02T09:00:00Z") }) as unknown as Office;

/**
 * An office that answers over the wire the way a real one does: refusing until
 * it is signed in to, and listing what it has afterwards.
 */
function anOffice(options: { readonly offices?: readonly Office[]; readonly token?: string } = {}) {
  const expected = options.token ?? "sk-owner";
  let signedIn = false;
  const made: string[] = [];
  const api = {
    signIn: (token: string) => {
      signedIn = token === expected;
      return Promise.resolve(
        signedIn
          ? { ok: true as const, value: true as const }
          : { ok: false as const, kind: "unauthorized" as const },
      );
    },
    signOut: () => {
      signedIn = false;
      return Promise.resolve({ ok: true as const, value: true as const });
    },
    listOffices: () =>
      Promise.resolve(
        signedIn
          ? {
              ok: true as const,
              value: [
                ...(options.offices ?? []),
                ...made.map((name, index) => office(`made-${String(index)}`, name)),
              ],
            }
          : { ok: false as const, kind: "unauthorized" as const },
      ),
    createOffice: (name: string) => {
      made.push(name);
      return Promise.resolve({
        ok: true as const,
        value: office(`made-${String(made.length - 1)}`, name),
      });
    },
    loadOffice: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          office: { id: "office-1", name: "Northwind", schedule: { kind: "always" } },
          departments: [],
          employees: [],
          tasks: [],
          connections: [],
          connectors: [],
        } as never,
      }),
    listDocuments: () => Promise.resolve({ ok: true as const, value: [] as never }),
    listUsage: () => Promise.resolve({ ok: true as const, value: [] as never }),
    officeSpend: () =>
      Promise.resolve({
        ok: true as const,
        value: { officeUsd: 0, unpricedCalls: 0, byDepartment: {}, byEmployee: {} },
      }),
  } as unknown as ApiClient;

  return { api, made, isSignedIn: () => signedIn };
}

function open(deps: { api: ApiClient }) {
  cleanup();
  localStorage.clear();
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <App
          session={{
            env: {},
            origin: served.baseUrl,
            probe: () => Promise.resolve(served),
            createClient: () => deps.api,
          }}
        />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("opening a canvas the office served", () => {
  it("asks for the token, because the page carries none", async () => {
    open(anOffice());
    expect(await screen.findByRole("form", { name: /sign in/i })).toBeTruthy();
  });

  it("will not send an empty one", async () => {
    open(anOffice());
    await screen.findByRole("form", { name: /sign in/i });
    expect(screen.getByRole("button", { name: /sign in/i })).toBeDisabled();
  });

  it("keeps the token out of the page it is typed into", async () => {
    // Typed as a password: not readable over somebody's shoulder, and not
    // something the browser offers to fill into the next form it sees.
    open(anOffice());
    await screen.findByRole("form", { name: /sign in/i });
    expect(screen.getByLabelText(/token/i)).toHaveAttribute("type", "password");
  });

  it("opens the office once the token is accepted", async () => {
    open(anOffice({ offices: [office("office-1", "Northwind")] }));
    await screen.findByRole("form", { name: /sign in/i });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/token/i), "sk-owner");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("navigation", { name: "Sections" })).toBeTruthy();
  });

  it("says so when the office refuses the token, and asks again", async () => {
    open(anOffice());
    await screen.findByRole("form", { name: /sign in/i });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/token/i), "sk-nonsense");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not a token/i);
    expect(screen.getByRole("form", { name: /sign in/i })).toBeTruthy();
  });

  it("forgets a refused token rather than leaving it in the field", async () => {
    open(anOffice());
    await screen.findByRole("form", { name: /sign in/i });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/token/i), "sk-nonsense");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await screen.findByRole("alert");

    expect(screen.getByLabelText(/token/i)).toHaveValue("sk-nonsense");
  });
});

describe("which office this browser is looking at", () => {
  const signIn = async () => {
    await screen.findByRole("form", { name: /sign in/i });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/token/i), "sk-owner");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    return user;
  };

  it("asks when there are several", async () => {
    open(anOffice({ offices: [office("office-1", "Northwind"), office("office-2", "Acme")] }));
    await signIn();

    const picker = await screen.findByRole("region", { name: /choose an office/i });
    expect(picker).toHaveTextContent("Northwind");
    expect(picker).toHaveTextContent("Acme");
  });

  it("opens the one that is chosen", async () => {
    open(anOffice({ offices: [office("office-1", "Northwind"), office("office-2", "Acme")] }));
    const user = await signIn();

    await user.click(await screen.findByRole("button", { name: /open acme/i }));
    expect(await screen.findByRole("navigation", { name: "Sections" })).toBeTruthy();
  });

  it("remembers the choice, so the next visit goes straight there", async () => {
    open(anOffice({ offices: [office("office-1", "Northwind"), office("office-2", "Acme")] }));
    const user = await signIn();
    await user.click(await screen.findByRole("button", { name: /open acme/i }));
    await screen.findByRole("navigation", { name: "Sections" });

    expect(localStorage.getItem("vo.office")).toBe("office-2");
  });

  it("offers to make the first one, which a fresh deployment has not got", async () => {
    const serving = anOffice({ offices: [] });
    open(serving);
    const user = await signIn();

    const picker = await screen.findByRole("region", { name: /choose an office/i });
    expect(picker).toHaveTextContent(/no office yet/i);

    await user.type(screen.getByLabelText(/name it/i), "Northwind Studio");
    await user.click(screen.getByRole("button", { name: /create office/i }));

    expect(serving.made).toEqual(["Northwind Studio"]);
    expect(await screen.findByRole("navigation", { name: "Sections" })).toBeTruthy();
  });
});

describe("signing out", () => {
  it("gives the cookie back and asks for the token again", async () => {
    const serving = anOffice({ offices: [office("office-1", "Northwind")] });
    open(serving);
    await screen.findByRole("form", { name: /sign in/i });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/token/i), "sk-owner");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await screen.findByRole("navigation", { name: "Sections" });

    await user.click(screen.getByRole("button", { name: /sign out/i }));

    expect(await screen.findByRole("form", { name: /sign in/i })).toBeTruthy();
    expect(serving.isSignedIn()).toBe(false);
  });

  it("is not offered to a canvas that was configured with a token of its own", async () => {
    // There is nothing to give back: that canvas holds its own credential.
    cleanup();
    vi.stubEnv("VITE_VO_API_URL", "");
    render(
      <ThemeProvider>
        <MemoryRouter>
          <App
            session={{ env: {}, origin: "http://nowhere.test", probe: () => Promise.resolve(null) }}
          />
        </MemoryRouter>
      </ThemeProvider>,
    );
    await screen.findByRole("navigation", { name: "Sections" });

    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
    vi.unstubAllEnvs();
  });
});
