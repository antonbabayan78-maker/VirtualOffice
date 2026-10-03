import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LlmService, Office, OfficeId } from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { Services } from "./Services.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-10-03T09:00:00Z");

const acme: Office = {
  id: officeId,
  name: "Acme Robotics",
  schedule: { kind: "always" },
  priority: "normal",
  runState: "running",
  budget: null,
  configVersion: 1,
  createdAt: at,
};

const service = (overrides: Record<string, unknown> = {}): LlmService =>
  ({
    id: "svc-openai",
    officeId,
    kind: "openai-compatible",
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    tokenEnv: null,
    secretRef: null,
    models: [],
    enabled: true,
    createdAt: at,
    ...overrides,
  }) as unknown as LlmService;

let store: OfficeStore;
/** What the office was asked to do, so a click is checked by its effect. */
let asked: { what: string; body: unknown }[];

function open(services: readonly LlmService[] = [], answers: Record<string, unknown> = {}) {
  cleanup();
  asked = [];
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().loadOffice(acme);
  store.getState().loadServices(services);
  const found = (id: string) => services.find((one) => one.id === id) ?? service();
  store.getState().connect({
    createService: (_officeId: string, input: Record<string, unknown>) => {
      asked.push({ what: "create", body: input });
      return Promise.resolve(
        answers["create"] ?? { ok: true, value: service({ id: "svc-new", ...input }) },
      );
    },
    patchService: (id: string, changes: Record<string, unknown>) => {
      asked.push({ what: "patch", body: { id, changes } });
      return Promise.resolve(answers["patch"] ?? { ok: true, value: { ...found(id), ...changes } });
    },
    deleteService: (id: string) => {
      asked.push({ what: "delete", body: id });
      return Promise.resolve(answers["delete"] ?? { ok: true, value: true });
    },
    setServiceCredential: (id: string, credential: Record<string, unknown>) => {
      asked.push({ what: "credential", body: { id, credential } });
      return Promise.resolve(
        answers["credential"] ?? {
          ok: true,
          value:
            typeof credential["tokenEnv"] === "string"
              ? { ...found(id), tokenEnv: credential["tokenEnv"], secretRef: null }
              : { ...found(id), secretRef: "vault://abc", tokenEnv: null },
        },
      );
    },
    clearServiceCredential: (id: string) => {
      asked.push({ what: "clear", body: id });
      return Promise.resolve(
        answers["clear"] ?? { ok: true, value: { ...found(id), secretRef: null, tokenEnv: null } },
      );
    },
    discoverServiceModels: (id: string) => {
      asked.push({ what: "discover", body: id });
      return Promise.resolve(
        answers["discover"] ?? {
          ok: true,
          value: { ...found(id), models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] },
        },
      );
    },
  } as never);
  return render(<Services store={store} />);
}

const panel = () => screen.getByRole("group", { name: /models this office may call/i });
const row = (name: string) => within(panel()).getByRole("group", { name });

beforeEach(() => {
  open();
});

describe("the services an office can call a model on", () => {
  it("says it has none when it has none", () => {
    // Worth stating: an office with no services calls whatever the deployment
    // was built with, which is not nothing and not visible here.
    expect(panel()).toHaveTextContent(/none of its own yet/i);
  });

  it("lists what it has, by name", () => {
    open([service({ id: "svc-z", name: "workshop" }), service()]);

    const names = within(panel())
      .getAllByRole("group")
      .map((one) => one.getAttribute("aria-label"));

    expect(names).toEqual(["openai", "workshop"]);
  });

  it("says where each one is, since that is what distinguishes them", () => {
    open([service()]);
    expect(row("openai")).toHaveTextContent("https://api.openai.com/v1");
  });

  it("adds one from what somebody typed", async () => {
    await userEvent.type(screen.getByLabelText("New service"), "grok");
    await userEvent.clear(screen.getByLabelText("Address"));
    await userEvent.type(screen.getByLabelText("Address"), "https://api.x.ai/v1");
    await userEvent.click(screen.getByRole("button", { name: "Add service" }));

    expect(asked[0]).toEqual({
      what: "create",
      body: { kind: "openai-compatible", name: "grok", baseUrl: "https://api.x.ai/v1" },
    });
  });

  it("fills in the address when a well-known service is picked, since nobody remembers it", async () => {
    await userEvent.selectOptions(screen.getByLabelText("Preset"), "deepseek");

    expect(screen.getByLabelText("Address")).toHaveValue("https://api.deepseek.com/v1");
    expect(screen.getByLabelText("New service")).toHaveValue("deepseek");
  });

  it("offers a local server, which needs no key at all", async () => {
    await userEvent.selectOptions(screen.getByLabelText("Preset"), "local");

    expect(screen.getByLabelText("Address")).toHaveValue("http://localhost:11434/v1");
  });

  it("asks for no address for the office's own built-in provider", async () => {
    await userEvent.selectOptions(screen.getByLabelText("Preset"), "anthropic");
    await userEvent.click(screen.getByRole("button", { name: "Add service" }));

    expect(asked[0]).toEqual({
      what: "create",
      body: { kind: "anthropic", name: "anthropic" },
    });
  });

  it("will not add one with no name", () => {
    expect(screen.getByRole("button", { name: "Add service" })).toBeDisabled();
  });

  it("says which field the office objected to", async () => {
    open([], {
      create: {
        ok: false,
        kind: "validation",
        errors: [{ path: "baseUrl", message: "must be https" }],
      },
    });
    await userEvent.type(screen.getByLabelText("New service"), "grok");

    await userEvent.click(screen.getByRole("button", { name: "Add service" }));

    expect(panel()).toHaveTextContent(/must be https/);
  });

  it("switches one off, and says what that means", async () => {
    open([service()]);

    await userEvent.click(within(row("openai")).getByLabelText("openai on"));

    expect(asked[0]).toEqual({
      what: "patch",
      body: { id: "svc-openai", changes: { enabled: false } },
    });
    expect(row("openai")).toHaveTextContent(/switched off/i);
  });

  it("takes one away", async () => {
    open([service()]);

    await userEvent.click(within(row("openai")).getByRole("button", { name: "Remove openai" }));

    expect(asked[0]).toEqual({ what: "delete", body: "svc-openai" });
  });
});

describe("the key a service needs", () => {
  it("says a service has none, which is right for a model on your own machine", () => {
    open([service({ name: "workshop", baseUrl: "http://localhost:11434/v1" })]);

    expect(row("workshop")).toHaveTextContent(/no key/i);
  });

  it("takes a pasted key and never shows it again", async () => {
    open([service()]);

    await userEvent.type(within(row("openai")).getByLabelText("Key for openai"), "sk-live-1");
    await userEvent.click(
      within(row("openai")).getByRole("button", { name: "Set key for openai" }),
    );

    expect(asked[0]).toEqual({
      what: "credential",
      body: { id: "svc-openai", credential: { apiKey: "sk-live-1" } },
    });
    // Cleared from the field, and the panel says only that there is one.
    expect(within(row("openai")).getByLabelText("Key for openai")).toHaveValue("");
    expect(row("openai")).toHaveTextContent(/key is set/i);
    expect(panel()).not.toHaveTextContent("sk-live-1");
  });

  it("never offers to show one back, because the office will not hand it over", () => {
    open([service({ secretRef: "vault://abc" })]);

    expect(within(row("openai")).queryByRole("button", { name: /show/i })).toBeNull();
    expect(row("openai")).not.toHaveTextContent("vault://abc");
  });

  it("names a variable instead, for a deployment that sets one", async () => {
    open([service()]);

    await userEvent.type(
      within(row("openai")).getByLabelText("Variable for openai"),
      "OPENAI_API_KEY",
    );
    await userEvent.click(
      within(row("openai")).getByRole("button", { name: "Name variable for openai" }),
    );

    expect(asked[0]).toEqual({
      what: "credential",
      body: { id: "svc-openai", credential: { tokenEnv: "OPENAI_API_KEY" } },
    });
  });

  it("says which variable a service reads, since that is not a secret", () => {
    open([service({ tokenEnv: "OPENAI_API_KEY" })]);

    expect(row("openai")).toHaveTextContent("OPENAI_API_KEY");
  });

  it("gives a key back", async () => {
    open([service({ secretRef: "vault://abc" })]);

    await userEvent.click(
      within(row("openai")).getByRole("button", { name: "Forget key for openai" }),
    );

    expect(asked[0]).toEqual({ what: "clear", body: "svc-openai" });
  });

  it("says when the office will not keep a key, so the paste is not silently lost", async () => {
    open([service()], {
      credential: { ok: false, kind: "transport", message: "this office cannot keep a key" },
    });

    await userEvent.type(within(row("openai")).getByLabelText("Key for openai"), "sk-live-1");
    await userEvent.click(
      within(row("openai")).getByRole("button", { name: "Set key for openai" }),
    );

    expect(row("openai")).toHaveTextContent(/cannot keep a key/);
  });
});

describe("the models a service offers", () => {
  it("says a service has not been asked yet", () => {
    open([service()]);
    expect(row("openai")).toHaveTextContent(/no models yet/i);
  });

  it("asks the service what it has", async () => {
    open([service()]);

    await userEvent.click(
      within(row("openai")).getByRole("button", { name: "Find its models for openai" }),
    );

    expect(asked[0]).toEqual({ what: "discover", body: "svc-openai" });
    expect(row("openai")).toHaveTextContent("gpt-5-mini");
  });

  it("says why a service could not be asked, because somebody pressed a button", async () => {
    open([service()], {
      discover: { ok: false, kind: "transport", message: "connection refused" },
    });

    await userEvent.click(
      within(row("openai")).getByRole("button", { name: "Find its models for openai" }),
    );

    expect(row("openai")).toHaveTextContent(/connection refused/);
  });

  it("will not ask a service that has no address", () => {
    open([service({ kind: "anthropic", name: "anthropic", baseUrl: null })]);

    expect(within(row("anthropic")).queryByRole("button", { name: /find its models/i })).toBeNull();
  });

  it("says what a model costs, where somebody has said", () => {
    open([
      service({
        models: [{ id: "gpt-5", pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } }],
      }),
    ]);

    expect(row("openai")).toHaveTextContent("gpt-5");
    expect(row("openai")).toHaveTextContent("1.25");
    expect(row("openai")).toHaveTextContent("10");
  });

  it("says plainly that an unpriced model is unpriced, rather than showing nothing", () => {
    // What it costs is not zero and not unknown-and-ignored: a call on it is
    // reported as unpriced, and the total for the day becomes a floor.
    open([service({ models: [{ id: "gpt-5" }] })]);

    expect(row("openai")).toHaveTextContent(/not priced/i);
  });

  it("takes the prices somebody types for a model nobody knows", async () => {
    open([service({ models: [{ id: "gpt-5" }] })]);

    await userEvent.type(within(row("openai")).getByLabelText("In, per Mtok, gpt-5"), "1.25");
    await userEvent.type(within(row("openai")).getByLabelText("Out, per Mtok, gpt-5"), "10");
    await userEvent.click(
      within(row("openai")).getByRole("button", { name: "Save prices for openai" }),
    );

    expect(asked[0]).toEqual({
      what: "patch",
      body: {
        id: "svc-openai",
        changes: { models: [{ id: "gpt-5", pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } }] },
      },
    });
  });

  it("takes a model away", async () => {
    open([service({ models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] })]);

    await userEvent.click(within(row("openai")).getByRole("button", { name: "Remove gpt-5-mini" }));

    expect(asked[0]).toEqual({
      what: "patch",
      body: { id: "svc-openai", changes: { models: [{ id: "gpt-5" }] } },
    });
  });

  it("takes one somebody types, for a service that will not list them", async () => {
    open([service()]);

    await userEvent.type(
      within(row("openai")).getByLabelText("New model for openai"),
      "o5-preview",
    );
    await userEvent.click(
      within(row("openai")).getByRole("button", { name: "Add model to openai" }),
    );

    expect(asked[0]).toEqual({
      what: "patch",
      body: { id: "svc-openai", changes: { models: [{ id: "o5-preview" }] } },
    });
  });
});
