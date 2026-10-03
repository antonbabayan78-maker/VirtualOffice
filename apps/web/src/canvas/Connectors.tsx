/**
 * What this office can reach outside itself.
 *
 * On the office panel because a connector belongs to the office, not to a room
 * or a person: two departments granted the same web connector are reaching the
 * same place under the same allowlist, and that is the point of it being one
 * thing. Who may use it is decided in the grants sections on the other drawers.
 *
 * Every change here is sent as it is made, unlike the office's own name and
 * priority, which are a draft with one Save. A connector is an entity of its own
 * rather than a field of the office, so there is nothing to batch it with — and
 * a switch that waits for a Save somewhere else reads as a switch that did not
 * work.
 *
 * Two kinds are offered, which is what this panel promised it would wait for:
 * the kind select came back when there was a second kind something could
 * actually perform. The two ask for different things — a web connector for the
 * hosts it may read, an MCP server for where it is and which of its tools stop
 * for a person — and an MCP server is the only one whose tools have to be asked
 * for, because only the server knows them.
 */
import { useState, type ReactNode } from "react";
import { TOOLS_BY_KIND, type Connector, type ConnectorKind, type ValidationError } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Field, Problems, inputClass } from "../ui/field.js";

/** The hosts a web connector may read, out of a configuration that is untyped. */
export function hostsOf(connector: Connector): readonly string[] {
  const raw = connector.config["hosts"];
  return Array.isArray(raw) ? raw.filter((host): host is string => typeof host === "string") : [];
}

/** Where an MCP server is, written the way somebody would type it. */
export function whereOf(connector: Connector): string {
  const url = connector.config["url"];
  if (typeof url === "string") return url;
  const command = connector.config["command"];
  if (typeof command !== "string") return "";
  const args = connector.config["args"];
  const listed = Array.isArray(args)
    ? args.filter((one): one is string => typeof one === "string")
    : [];
  return [command, ...listed].join(" ");
}

/**
 * One line, read as either an address or a command line.
 *
 * One field rather than two, because an owner knows which of the two they have
 * and being asked to classify it first is a form being clever at somebody
 * else's expense. Anything that starts like a url is one; everything else is a
 * command and its arguments, which is how such a thing is written down
 * everywhere else.
 */
export function parseWhere(typed: string): Record<string, unknown> {
  const text = typed.trim();
  if (text.length === 0) return {};
  if (/^https?:\/\//i.test(text)) return { url: text };
  const [command, ...args] = text.split(/\s+/);
  return command === undefined ? {} : { command, args };
}

/** The keys that say where a server is, so changing it does not leave the old one. */
const LOCATION_KEYS = ["command", "args", "url"];

function withWhere(connector: Connector, typed: string): Record<string, unknown> {
  const kept = Object.fromEntries(
    Object.entries(connector.config).filter(([key]) => !LOCATION_KEYS.includes(key)),
  );
  return { ...kept, ...parseWhere(typed) };
}

/** What the office has declared about this connector's tools. */
function gatesOf(connector: Connector): Readonly<Record<string, unknown>> {
  const raw = connector.config["gates"];
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * Whether a tool stops for a person.
 *
 * True unless the office has said this one is harmless, which is the same
 * default the connector itself applies: a tool nobody has considered is treated
 * as one that acts.
 */
export function needsAPerson(connector: Connector, tool: string): boolean {
  const declared = gatesOf(connector)[tool];
  return !(Array.isArray(declared) && declared.length === 0);
}

function WebConnector({
  store,
  connector,
}: {
  readonly store: OfficeStore;
  readonly connector: Connector;
}): ReactNode {
  const [newHost, setNewHost] = useState("");
  const hosts = hostsOf(connector);

  /** Hosts change inside the configuration, never instead of it: a later kind's
   * settings live in the same object, and replacing it would drop them. */
  const withHosts = (next: readonly string[]): void => {
    void store
      .getState()
      .saveConnector(connector.id, { config: { ...connector.config, hosts: next } });
  };

  return (
    <>
      {hosts.length === 0 ? (
        // An allowlist that says nothing allows nothing, so saying nothing here
        // would read as "no restrictions".
        <p className="text-[10px] text-ink-muted">No hosts yet, so it reaches nothing.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {hosts.map((host) => (
            <li key={host} className="flex items-center gap-2 text-[11px] text-ink">
              <span className="min-w-0 truncate">{host}</span>
              <button
                type="button"
                aria-label={`Remove ${host}`}
                className="ml-auto shrink-0 text-ink-muted hover:text-ink"
                onClick={() => {
                  withHosts(hosts.filter((candidate) => candidate !== host));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <Field label="New host">
          <input
            className={inputClass}
            placeholder="help.figma.com"
            value={newHost}
            onChange={(event) => {
              setNewHost(event.target.value);
            }}
          />
        </Field>
        <Button
          aria-label={`Add host to ${connector.name}`}
          disabled={newHost.trim().length === 0 || hosts.includes(newHost.trim())}
          onClick={() => {
            withHosts([...hosts, newHost.trim()]);
            setNewHost("");
          }}
        >
          Add
        </Button>
      </div>
    </>
  );
}

function McpConnector({
  store,
  connector,
}: {
  readonly store: OfficeStore;
  readonly connector: Connector;
}): ReactNode {
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);
  const [asking, setAsking] = useState(false);

  const save = (changes: Record<string, unknown>): void => {
    void store
      .getState()
      .saveConnector(connector.id, changes)
      .then((result) => {
        setProblems(result.ok ? [] : result.problems);
      });
  };

  const find = (): void => {
    setAsking(true);
    void store
      .getState()
      .discoverConnectorTools(connector.id)
      .then((result) => {
        setAsking(false);
        setProblems(result.ok ? [] : result.problems);
      });
  };

  return (
    <>
      <Field label="Command or address">
        <input
          className={inputClass}
          placeholder="npx -y @acme/mcp"
          defaultValue={whereOf(connector)}
          // Saved on leaving the field rather than on every keystroke: half a
          // command line is a connector that reaches nothing.
          onBlur={(event) => {
            const typed = event.target.value;
            if (typed.trim() === whereOf(connector)) return;
            save({ config: withWhere(connector, typed) });
          }}
        />
      </Field>

      {connector.tools.length === 0 ? (
        <p className="text-[10px] text-ink-muted">
          Nothing to grant yet. Only the server knows what it offers, so ask it.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {connector.tools.map((tool) => (
            <li key={tool} className="flex items-center gap-2 text-[11px] text-ink">
              <span className="min-w-0 truncate">{tool}</span>
              <label className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-ink-muted">
                <input
                  type="checkbox"
                  className="accent-accent"
                  aria-label={`${tool} needs a person`}
                  checked={needsAPerson(connector, tool)}
                  onChange={(event) => {
                    // Quieted by saying so; asked for again by saying nothing,
                    // which is what the connector's own default means.
                    const declared = Object.entries(gatesOf(connector)).filter(
                      ([named]) => named !== tool,
                    );
                    const gates = Object.fromEntries(
                      event.target.checked ? declared : [...declared, [tool, []]],
                    );
                    save({ config: { ...connector.config, gates } });
                  }}
                />
                Needs a person
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button
          aria-label={`Find its tools for ${connector.name}`}
          disabled={asking || whereOf(connector).length === 0}
          onClick={find}
        >
          {asking ? "Asking…" : "Find its tools"}
        </Button>
        <span className="text-[10px] text-ink-muted">
          Asks the server what it offers, so the tools can be granted.
        </span>
      </div>

      <Problems problems={problems} />
    </>
  );
}

function OneConnector({
  store,
  connector,
}: {
  readonly store: OfficeStore;
  readonly connector: Connector;
}): ReactNode {
  return (
    <div
      role="group"
      aria-label={connector.name}
      className="flex flex-col gap-1.5 rounded-panel border border-border p-2"
    >
      <div className="flex items-center gap-2 text-xs text-ink">
        <span className="min-w-0 truncate font-medium">{connector.name}</span>
        <span className="shrink-0 rounded bg-surface-muted px-1 text-[10px] text-ink-muted">
          {connector.kind}
        </span>
        <label className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-ink-muted">
          <input
            type="checkbox"
            className="accent-accent"
            aria-label={`${connector.name} on`}
            checked={connector.enabled}
            onChange={(event) => {
              void store.getState().saveConnector(connector.id, { enabled: event.target.checked });
            }}
          />
          On
        </label>
        <button
          type="button"
          aria-label={`Remove ${connector.name}`}
          className="shrink-0 text-ink-muted hover:text-ink"
          onClick={() => {
            void store.getState().removeConnector(connector.id);
          }}
        >
          ×
        </button>
      </div>

      {!connector.enabled && (
        <p className="text-[10px] text-ink-muted">
          Switched off. Whoever was granted it keeps the grant, and it grants nothing until this is
          back on.
        </p>
      )}

      {connector.kind === "mcp" ? (
        <McpConnector store={store} connector={connector} />
      ) : (
        <WebConnector store={store} connector={connector} />
      )}
    </div>
  );
}

/** The kinds something in this office can actually perform. */
const OFFERED_KINDS: readonly ConnectorKind[] = ["web", "mcp"];

export function Connectors({ store }: { readonly store: OfficeStore }): ReactNode {
  const office = store((state) => state.office);
  const connectors = store((state) => state.connectors);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ConnectorKind>("web");
  const [where, setWhere] = useState("");
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);

  // Nothing to add one to: a panel that cannot save is worse than no panel.
  if (office === null) return null;

  const add = (): void => {
    void store
      .getState()
      .addConnector({
        kind,
        name: name.trim(),
        config: kind === "mcp" ? parseWhere(where) : { hosts: [] },
      })
      .then((result) => {
        setProblems(result.ok ? [] : result.problems);
        // Kept on a refusal: the name is what the office objected to, and
        // clearing it would make the complaint unanswerable.
        if (result.ok) {
          setName("");
          setWhere("");
        }
      });
  };

  return (
    <section
      role="group"
      aria-label="What this office can reach"
      className="flex flex-col gap-2 rounded-panel border border-border p-2"
    >
      <p className="text-xs font-medium text-ink">What this office can reach</p>
      <p className="text-[11px] text-ink-muted">
        Places outside this office that its employees may use. Adding one here does not grant it to
        anybody — a department or a person is granted it on their own panel.
      </p>

      <Problems problems={problems} />

      {connectors.length === 0 ? (
        <p className="text-xs text-ink-muted">This office reaches nothing outside itself yet.</p>
      ) : (
        connectors.map((connector) => (
          <OneConnector key={connector.id} store={store} connector={connector} />
        ))
      )}

      <div className="flex items-end gap-2">
        {/* "New connector" rather than "Name", matching "New host" above and the
            other list editors in these drawers — and the office's own Name field
            is on this same panel, where two fields labelled the same is a panel
            nobody can describe out loud. */}
        <Field label="New connector">
          <input
            className={inputClass}
            placeholder={kind === "mcp" ? "acme-notes" : "design-web"}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Field label="Kind">
          <select
            className={inputClass}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as ConnectorKind);
            }}
          >
            {OFFERED_KINDS.map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </select>
        </Field>
        <Button
          aria-label="Add connector"
          disabled={name.trim().length === 0 || (kind === "mcp" && where.trim().length === 0)}
          onClick={add}
        >
          Add
        </Button>
      </div>

      {kind === "mcp" && (
        <Field label="Command or address">
          <input
            className={inputClass}
            placeholder="npx -y @acme/mcp"
            value={where}
            onChange={(event) => {
              setWhere(event.target.value);
            }}
          />
        </Field>
      )}

      <p className="text-[10px] text-ink-muted">
        {kind === "mcp"
          ? "An MCP server: a command this office runs, or an address it posts to. Its tools are" +
            " asked for, and each one stops for a person until you say it is harmless."
          : `Reads web pages, and only the hosts you name. It offers ${TOOLS_BY_KIND.web.join(", ")}.`}
      </p>
    </section>
  );
}
