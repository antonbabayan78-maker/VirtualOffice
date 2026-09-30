/**
 * Who may use what the office can reach.
 *
 * One row per connector with a single "everything it offers" tick, because that
 * is how an office is actually described — "Design gets Figma", not "Design gets
 * get_file, post_comment, get_comments and eleven others". The individual tools
 * are there, one click away, for when a connector offers something nobody should
 * have; keeping them folded away is what stops this panel being forty rows long
 * when an MCP server turns up.
 *
 * The control cannot express a grant naming nothing. Free text could, and the
 * office refuses those now, so a text field here would exist only to be refused.
 *
 * A department's grants reach everybody in it, and an employee's add to them.
 * There is no way to subtract — `resolveToolAccess` unions the two lists — so an
 * inherited grant is shown ticked and not changeable here. An unticked box that
 * granted the tool anyway would be a lie, and a tickable one would suggest the
 * person could be cut off from something their room gives them.
 */
import { useState, type ReactNode } from "react";
import { WILDCARD_TOOL, type Connector, type ToolGrant } from "@vo/core";

export type GrantOwner = "department" | "employee";

const HEADING: Readonly<Record<GrantOwner, string>> = {
  department: "What this department may use",
  employee: "What they may use",
};

const NOTE: Readonly<Record<GrantOwner, string>> = {
  department:
    "Everyone in this department may use these. A person can be granted more on their own panel, never less.",
  employee:
    "On top of what their department gives everybody. What the department grants is shown ticked and cannot be taken away here.",
};

const has = (grants: readonly ToolGrant[], connectorId: string, tool: string): boolean =>
  grants.some((grant) => grant.connectorId === connectorId && grant.tool === tool);

function OneConnector({
  connector,
  grants,
  inherited,
  onChange,
}: {
  readonly connector: Connector;
  readonly grants: readonly ToolGrant[];
  readonly inherited: readonly ToolGrant[];
  readonly onChange: (grants: readonly ToolGrant[]) => void;
}): ReactNode {
  const [showTools, setShowTools] = useState(false);

  const all = has(grants, connector.id, WILDCARD_TOOL);
  const allInherited = has(inherited, connector.id, WILDCARD_TOOL);
  /** Everything this connector's grants come to, whoever granted them. */
  const granted = connector.tools.filter(
    (tool) =>
      all || allInherited || has(grants, connector.id, tool) || has(inherited, connector.id, tool),
  );

  /** Only this connector's own grants are rewritten; the rest pass through. */
  const replace = (mine: readonly ToolGrant[]): void => {
    onChange([...grants.filter((grant) => grant.connectorId !== connector.id), ...mine]);
  };

  const toggleAll = (on: boolean): void => {
    // Single grants go with it: kept alongside a wildcard they say nothing, and
    // unticking everything later would silently leave them granting.
    replace(on ? [{ connectorId: connector.id, tool: WILDCARD_TOOL }] : []);
  };

  const toggleTool = (tool: string, on: boolean): void => {
    const mine = grants.filter(
      (grant) => grant.connectorId === connector.id && grant.tool !== tool,
    );
    replace(on ? [...mine, { connectorId: connector.id, tool }] : mine);
  };

  return (
    <div
      role="group"
      aria-label={connector.name}
      className="flex flex-col gap-1 rounded-panel border border-border p-2"
    >
      <div className="flex items-center gap-2 text-xs text-ink">
        <label className="flex min-w-0 items-center gap-1.5">
          <input
            type="checkbox"
            className="shrink-0 accent-accent"
            aria-label={`${connector.name}: everything it offers`}
            checked={all || allInherited}
            disabled={allInherited}
            onChange={(event) => {
              toggleAll(event.target.checked);
            }}
          />
          <span className="min-w-0 truncate font-medium">{connector.name}</span>
        </label>
        <span className="shrink-0 text-[10px] text-ink-muted">
          {granted.length === connector.tools.length && granted.length > 0
            ? "everything it offers"
            : `${String(granted.length)} of ${String(connector.tools.length)}`}
        </span>
        <button
          type="button"
          aria-label={`Choose tools from ${connector.name}`}
          aria-expanded={showTools}
          className="ml-auto shrink-0 text-[10px] text-ink-muted hover:text-ink"
          onClick={() => {
            setShowTools(!showTools);
          }}
        >
          {showTools ? "Hide tools" : "Tools"}
        </button>
      </div>

      {allInherited && <p className="text-[10px] text-ink-muted">Given by their department.</p>}
      {!connector.enabled && (
        <p className="text-[10px] text-ink-muted">
          Switched off at the office, so this grants nothing until it is back on.
        </p>
      )}

      {showTools && (
        <ul className="flex flex-col gap-0.5 pl-5">
          {connector.tools.map((tool) => {
            // Covered already: by the wildcard on this row, or by the room.
            const locked = all || allInherited || has(inherited, connector.id, tool);
            return (
              <li key={tool}>
                <label className="flex items-center gap-1.5 text-[11px] text-ink">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    aria-label={`${connector.name}: ${tool}`}
                    checked={locked || has(grants, connector.id, tool)}
                    disabled={locked}
                    onChange={(event) => {
                      toggleTool(tool, event.target.checked);
                    }}
                  />
                  {tool}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Grants({
  connectors,
  grants,
  inherited = [],
  owner,
  onChange,
}: {
  readonly connectors: readonly Connector[];
  /** This entity's own grants. A department's are never in here on an employee. */
  readonly grants: readonly ToolGrant[];
  /** What the employee's department already gives everybody in it. */
  readonly inherited?: readonly ToolGrant[];
  readonly owner: GrantOwner;
  readonly onChange: (grants: readonly ToolGrant[]) => void;
}): ReactNode {
  return (
    <section
      role="group"
      aria-label={HEADING[owner]}
      className="flex flex-col gap-2 rounded-panel border border-border p-2"
    >
      <p className="text-xs font-medium text-ink">{HEADING[owner]}</p>
      <p className="text-[11px] text-ink-muted">{NOTE[owner]}</p>

      {connectors.length === 0 ? (
        // Said rather than hidden: somebody looking for "let Design use Figma"
        // needs to know the office has nothing to grant, and where that is fixed.
        <p className="text-xs text-ink-muted">
          This office reaches nothing outside itself yet. Add something on the office panel first.
        </p>
      ) : (
        connectors.map((connector) => (
          <OneConnector
            key={connector.id}
            connector={connector}
            grants={grants}
            inherited={inherited}
            onChange={onChange}
          />
        ))
      )}
    </section>
  );
}
