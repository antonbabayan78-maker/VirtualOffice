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
 * Only the web kind is offered. An MCP connector added here would be granted and
 * would then perform nothing, which is the failure this codebase keeps making:
 * machinery built ahead of the thing that performs it. The select comes back when
 * there is a second kind something can actually do.
 */
import { useState, type ReactNode } from "react";
import { TOOLS_BY_KIND, type Connector, type ValidationError } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Field, Problems, inputClass } from "../ui/field.js";

/** The hosts a web connector may read, out of a configuration that is untyped. */
export function hostsOf(connector: Connector): readonly string[] {
  const raw = connector.config["hosts"];
  return Array.isArray(raw) ? raw.filter((host): host is string => typeof host === "string") : [];
}

function OneConnector({
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
    </div>
  );
}

export function Connectors({ store }: { readonly store: OfficeStore }): ReactNode {
  const office = store((state) => state.office);
  const connectors = store((state) => state.connectors);
  const [name, setName] = useState("");
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);

  // Nothing to add one to: a panel that cannot save is worse than no panel.
  if (office === null) return null;

  const add = (): void => {
    void store
      .getState()
      .addConnector({ kind: "web", name: name.trim(), config: { hosts: [] } })
      .then((result) => {
        setProblems(result.ok ? [] : result.problems);
        // Kept on a refusal: the name is what the office objected to, and
        // clearing it would make the complaint unanswerable.
        if (result.ok) setName("");
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
            placeholder="design-web"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Button aria-label="Add connector" disabled={name.trim().length === 0} onClick={add}>
          Add
        </Button>
      </div>
      <p className="text-[10px] text-ink-muted">
        Reads web pages, and only the hosts you name. It offers {TOOLS_BY_KIND.web.join(", ")}.
      </p>
    </section>
  );
}
