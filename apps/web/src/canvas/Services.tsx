/**
 * The models this office may call.
 *
 * On the office panel beside the connectors, and for the same reason: a service
 * belongs to the office rather than to a room or a person. Who calls it is
 * decided on an employee's own panel, where `llm.provider` names one of these
 * by name.
 *
 * **One shape covers almost everything.** OpenAI, Grok, DeepSeek, Qwen and the
 * gateways all speak the same protocol, and so does every local runner — Ollama,
 * vLLM, llama.cpp, LM Studio. They differ by address, so the presets fill in an
 * address and nothing else. The office's own built-in provider is the one
 * exception, and it has no address at all.
 *
 * **A key may be set here and never read.** The office answers a key to a
 * worker's own token and never to a browser, so there is nothing to show and no
 * button that offers to. A service says only whether it has one, or which
 * variable it reads — a variable's name is not a secret and is the thing
 * somebody needs to check when a call is refused.
 *
 * **An unpriced model says so.** The office reports a call on one as unpriced
 * rather than free, and the day's total becomes a floor. Saying nothing here
 * would read as "it costs nothing", which is the one thing it does not mean.
 */
import { useState, type ReactNode } from "react";
import type { LlmService, LlmServiceKind, ModelOffer } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Field, Problems, inputClass } from "../ui/field.js";

/** Somewhere to start, because nobody remembers these addresses. */
interface Preset {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly kind: LlmServiceKind;
  readonly baseUrl: string;
}

/** OpenAI, as the one everybody has heard of, and the fallback. */
const OPENAI: Preset = {
  id: "openai",
  label: "OpenAI",
  name: "openai",
  kind: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
};

export const PRESETS: readonly Preset[] = [
  OPENAI,
  {
    id: "grok",
    label: "Grok",
    name: "grok",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    name: "deepseek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    id: "qwen",
    label: "Qwen",
    name: "qwen",
    kind: "openai-compatible",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    name: "openrouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    // The case this whole section exists for: a model on this machine, or on a
    // box in the company network, which needs no key at all.
    id: "local",
    label: "A server of my own",
    name: "workshop",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
  },
  { id: "anthropic", label: "Anthropic", name: "anthropic", kind: "anthropic", baseUrl: "" },
];

const presetOf = (id: string): Preset => PRESETS.find((one) => one.id === id) ?? OPENAI;

/** What the office is reading a key from, in words rather than as a secret. */
function KeyState({ service }: { readonly service: LlmService }): ReactNode {
  if (service.tokenEnv !== null) {
    return (
      <p className="text-[10px] text-ink-muted">
        Reads its key from <span className="font-medium text-ink">{service.tokenEnv}</span> where
        this office runs.
      </p>
    );
  }
  if (service.secretRef !== null) {
    // Said, never shown: the office hands a key to a worker's own token and
    // never to a browser, so there is nothing here that could show one.
    return <p className="text-[10px] text-ink-muted">A key is set. It cannot be read back.</p>;
  }
  return (
    <p className="text-[10px] text-ink-muted">
      No key. Right for a model on this machine, and not for anything else.
    </p>
  );
}

function Credential({
  store,
  service,
  say,
}: {
  readonly store: OfficeStore;
  readonly service: LlmService;
  readonly say: (problems: readonly { readonly path: string; readonly message: string }[]) => void;
}): ReactNode {
  const [key, setKey] = useState("");
  const [variable, setVariable] = useState("");

  const set = (credential: { apiKey: string } | { tokenEnv: string }): void => {
    void store
      .getState()
      .setServiceKey(service.id, credential)
      .then((result) => {
        say(result.ok ? [] : result.problems);
        // Cleared either way: a field still holding a key after the office
        // refused it is a key sitting in a browser for no reason.
        if (result.ok) {
          setKey("");
          setVariable("");
        }
      });
  };

  return (
    <div className="flex flex-col gap-1">
      <KeyState service={service} />
      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <Field label={`Key for ${service.name}`}>
            <input
              className={inputClass}
              type="password"
              placeholder="sk-…"
              autoComplete="off"
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
              }}
            />
          </Field>
        </div>
        <Button
          aria-label={`Set key for ${service.name}`}
          disabled={key.trim().length === 0}
          onClick={() => {
            set({ apiKey: key.trim() });
          }}
        >
          Set
        </Button>
      </div>
      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <Field label={`Variable for ${service.name}`}>
            <input
              className={inputClass}
              placeholder="OPENAI_API_KEY"
              value={variable}
              onChange={(event) => {
                setVariable(event.target.value);
              }}
            />
          </Field>
        </div>
        <Button
          aria-label={`Name variable for ${service.name}`}
          disabled={variable.trim().length === 0}
          onClick={() => {
            set({ tokenEnv: variable.trim() });
          }}
        >
          Name
        </Button>
      </div>
      {(service.secretRef !== null || service.tokenEnv !== null) && (
        <button
          type="button"
          aria-label={`Forget key for ${service.name}`}
          className="self-start text-[10px] text-ink-muted hover:text-ink"
          onClick={() => {
            void store
              .getState()
              .clearServiceKey(service.id)
              .then((result) => {
                say(result.ok ? [] : result.problems);
              });
          }}
        >
          Forget it
        </button>
      )}
    </div>
  );
}

/** A number somebody typed, or undefined for a field left alone. */
function priceOf(typed: string): number | undefined {
  const text = typed.trim();
  if (text.length === 0) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function Models({
  store,
  service,
  say,
}: {
  readonly store: OfficeStore;
  readonly service: LlmService;
  readonly say: (problems: readonly { readonly path: string; readonly message: string }[]) => void;
}): ReactNode {
  const [typed, setTyped] = useState<Record<string, { in?: string; out?: string }>>({});
  const [added, setAdded] = useState("");
  const [asking, setAsking] = useState(false);

  const save = (models: readonly ModelOffer[]): Promise<void> =>
    store
      .getState()
      .saveService(service.id, { models })
      .then((result) => {
        say(result.ok ? [] : result.problems);
      });

  /** The prices somebody typed, written onto the models they belong to. */
  const savePrices = (): void => {
    const next = service.models.map((model) => {
      const entry = typed[model.id];
      const input = priceOf(entry?.in ?? "");
      const output = priceOf(entry?.out ?? "");
      // Both or neither: half a price is a figure nobody can trust, and the
      // office refuses one anyway.
      if (input === undefined || output === undefined) return model;
      return { ...model, pricing: { inputPerMTok: input, outputPerMTok: output } };
    });
    void save(next).then(() => {
      setTyped({});
    });
  };

  const find = (): void => {
    setAsking(true);
    void store
      .getState()
      .discoverServiceModels(service.id)
      .then((result) => {
        setAsking(false);
        say(result.ok ? [] : result.problems);
      });
  };

  return (
    <div className="flex flex-col gap-1">
      {service.models.length === 0 ? (
        <p className="text-[10px] text-ink-muted">No models yet, so nobody can be put on one.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {service.models.map((model) => {
            const entry = typed[model.id];
            return (
              <li key={model.id} className="flex items-center gap-1.5 text-[10px] text-ink">
                <span className="min-w-0 flex-1 truncate">{model.id}</span>
                {model.pricing === undefined ? (
                  <>
                    <span className="shrink-0 text-ink-muted">not priced</span>
                    <input
                      aria-label={`In, per Mtok, ${model.id}`}
                      className="w-14 shrink-0 rounded border border-border bg-surface px-1 py-0.5 text-[10px] text-ink"
                      placeholder="in"
                      value={entry?.in ?? ""}
                      onChange={(event) => {
                        setTyped({ ...typed, [model.id]: { ...entry, in: event.target.value } });
                      }}
                    />
                    <input
                      aria-label={`Out, per Mtok, ${model.id}`}
                      className="w-14 shrink-0 rounded border border-border bg-surface px-1 py-0.5 text-[10px] text-ink"
                      placeholder="out"
                      value={entry?.out ?? ""}
                      onChange={(event) => {
                        setTyped({ ...typed, [model.id]: { ...entry, out: event.target.value } });
                      }}
                    />
                  </>
                ) : (
                  <span className="shrink-0 tabular-nums text-ink-muted">
                    ${model.pricing.inputPerMTok} in / ${model.pricing.outputPerMTok} out per Mtok
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${model.id}`}
                  className="shrink-0 text-ink-muted hover:text-ink"
                  onClick={() => {
                    void save(service.models.filter((one) => one.id !== model.id));
                  }}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {Object.keys(typed).length > 0 && (
        <Button
          aria-label={`Save prices for ${service.name}`}
          onClick={() => {
            savePrices();
          }}
        >
          Save prices
        </Button>
      )}

      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <Field label={`New model for ${service.name}`}>
            <input
              className={inputClass}
              placeholder="gpt-5"
              value={added}
              onChange={(event) => {
                setAdded(event.target.value);
              }}
            />
          </Field>
        </div>
        <Button
          aria-label={`Add model to ${service.name}`}
          disabled={added.trim().length === 0}
          onClick={() => {
            void save([...service.models, { id: added.trim() }]).then(() => {
              setAdded("");
            });
          }}
        >
          Add
        </Button>
        {/* Only where there is somewhere to ask: the office's own provider has
            no address, and its models are the ones the office was born with. */}
        {service.baseUrl !== null && (
          <Button
            aria-label={`Find its models for ${service.name}`}
            disabled={asking}
            onClick={find}
          >
            {asking ? "Asking…" : "Find its models"}
          </Button>
        )}
      </div>
    </div>
  );
}

function OneService({
  store,
  service,
}: {
  readonly store: OfficeStore;
  readonly service: LlmService;
}): ReactNode {
  const [problems, setProblems] = useState<
    readonly { readonly path: string; readonly message: string }[]
  >([]);

  return (
    <div
      role="group"
      aria-label={service.name}
      className="flex flex-col gap-1.5 rounded-panel border border-border p-2"
    >
      <div className="flex items-center gap-2 text-xs text-ink">
        <span className="min-w-0 truncate font-medium">{service.name}</span>
        <label className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-ink-muted">
          <input
            type="checkbox"
            className="accent-accent"
            aria-label={`${service.name} on`}
            checked={service.enabled}
            onChange={(event) => {
              void store
                .getState()
                .saveService(service.id, { enabled: event.target.checked })
                .then((result) => {
                  setProblems(result.ok ? [] : result.problems);
                });
            }}
          />
          On
        </label>
        <button
          type="button"
          aria-label={`Remove ${service.name}`}
          className="shrink-0 text-ink-muted hover:text-ink"
          onClick={() => {
            void store.getState().removeService(service.id);
          }}
        >
          ×
        </button>
      </div>

      <p className="truncate text-[10px] text-ink-muted">
        {service.baseUrl ?? "This office's own provider."}
      </p>

      {!service.enabled && (
        <p className="text-[10px] text-ink-muted">
          Switched off. Anybody put on it falls back to the provider this office was started with.
        </p>
      )}

      <Credential store={store} service={service} say={setProblems} />
      <Models store={store} service={service} say={setProblems} />

      <Problems problems={problems} />
    </div>
  );
}

export function Services({ store }: { readonly store: OfficeStore }): ReactNode {
  const office = store((state) => state.office);
  const services = store((state) => state.services);
  const [preset, setPreset] = useState(OPENAI.id);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(OPENAI.baseUrl);
  const [problems, setProblems] = useState<
    readonly { readonly path: string; readonly message: string }[]
  >([]);

  // Nothing to add one to: a panel that cannot save is worse than no panel.
  if (office === null) return null;

  const chosen = presetOf(preset);

  const add = (): void => {
    void store
      .getState()
      .addService({
        kind: chosen.kind,
        name: name.trim().length === 0 ? chosen.name : name.trim(),
        ...(chosen.kind === "anthropic" || baseUrl.trim().length === 0
          ? {}
          : { baseUrl: baseUrl.trim() }),
      })
      .then((result) => {
        setProblems(result.ok ? [] : result.problems);
        // Kept on a refusal: what was typed is what the office objected to.
        if (result.ok) setName("");
      });
  };

  return (
    <section
      role="group"
      aria-label="Models this office may call"
      className="flex flex-col gap-2 rounded-panel border border-border p-2"
    >
      <p className="text-xs font-medium text-ink">Models this office may call</p>
      <p className="text-[11px] text-ink-muted">
        A hosted service, or a server of your own on this machine or in your network. Adding one
        does not put anybody on it — a person is given a model on their own panel.
      </p>

      <Problems problems={problems} />

      {services.length === 0 ? (
        <p className="text-xs text-ink-muted">
          This office has none of its own yet, so everybody runs on whatever it was started with.
        </p>
      ) : (
        services.map((service) => <OneService key={service.id} store={store} service={service} />)
      )}

      <div className="flex items-end gap-2">
        <Field label="Preset">
          <select
            className={inputClass}
            value={preset}
            onChange={(event) => {
              const next = presetOf(event.target.value);
              setPreset(next.id);
              // Filled in rather than only suggested: nobody remembers these
              // addresses, and both are still editable.
              setBaseUrl(next.baseUrl);
              setName(next.name);
            }}
          >
            {PRESETS.map((one) => (
              <option key={one.id} value={one.id}>
                {one.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="New service">
          <input
            className={inputClass}
            placeholder={chosen.name}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Button
          aria-label="Add service"
          disabled={
            (name.trim().length === 0 && chosen.kind !== "anthropic") ||
            (chosen.kind !== "anthropic" && baseUrl.trim().length === 0)
          }
          onClick={add}
        >
          Add
        </Button>
      </div>

      {chosen.kind !== "anthropic" && (
        <Field label="Address">
          <input
            className={inputClass}
            placeholder="https://api.openai.com/v1"
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
            }}
          />
        </Field>
      )}

      <p className="text-[10px] text-ink-muted">
        {chosen.kind === "anthropic"
          ? "This office's own provider. It needs no address, and takes its key from where the" +
            " office runs."
          : "Anything that speaks the OpenAI chat protocol, which is nearly everything — including" +
            " Ollama, vLLM, llama.cpp and LM Studio. Plain http is allowed only inside your own" +
            " network."}
      </p>
    </section>
  );
}
