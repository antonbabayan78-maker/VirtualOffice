/**
 * Connector: an external capability source (MCP server, REST API, webhook, plugin)
 * that exposes named tools. Employees may only call tools they were granted,
 * directly or through their department. Wildcard "*" grants every tool of a connector.
 */
import type { OfficeId } from "../office/office.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

declare const connectorIdBrand: unique symbol;
export type ConnectorId = string & { readonly [connectorIdBrand]: true };

export const CONNECTOR_KINDS = ["mcp", "rest", "webhook", "plugin"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const WILDCARD_TOOL = "*";

export interface ToolGrant {
  readonly connectorId: string;
  /** Tool name within the connector, or "*" for every tool it exposes. */
  readonly tool: string;
}

export interface Connector {
  readonly id: ConnectorId;
  readonly officeId: OfficeId;
  readonly kind: ConnectorKind;
  /** Unique per office, kebab-case; used as the prefix in skill tool refs ("github.get_diff"). */
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Reference into the secrets vault; the secret itself never lives here. */
  readonly secretRef: string | null;
  /** Tool names discovered from the connector. */
  readonly tools: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: Date;
}

export interface CreateConnectorInput {
  readonly officeId: OfficeId;
  readonly kind: ConnectorKind;
  readonly name: string;
  readonly tools: readonly string[];
  readonly config?: Record<string, unknown>;
  readonly secretRef?: string;
  readonly enabled?: boolean;
}

export interface ConnectorDeps {
  readonly id: () => ConnectorId;
  readonly now: () => Date;
}

export interface GrantContext {
  readonly connectors: readonly Connector[];
  readonly departmentGrants: readonly ToolGrant[];
  readonly employeeGrants: readonly ToolGrant[];
}

export interface ResolvedTool {
  readonly connectorId: ConnectorId;
  readonly tool: string;
}

export type ToolDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "unknown_connector" | "connector_disabled" | "unknown_tool" | "not_granted";
    };

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isKind(v: unknown): v is ConnectorKind {
  return typeof v === "string" && (CONNECTOR_KINDS as readonly string[]).includes(v);
}

export function createConnector(
  input: CreateConnectorInput,
  existing: readonly { readonly name: string }[],
  deps: ConnectorDeps,
): Result<Connector> {
  const errors: ValidationError[] = [];
  if (!isKind(input.kind))
    errors.push({ path: "kind", message: `must be one of ${CONNECTOR_KINDS.join(", ")}` });

  const name = input.name.trim();
  if (!NAME.test(name))
    errors.push({ path: "name", message: "must be a kebab-case identifier of 1-64 characters" });
  else if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    errors.push({
      path: "name",
      message: `a connector named "${name}" already exists in this office`,
    });
  }

  const seen = new Set<string>();
  input.tools.forEach((tool, i) => {
    const path = `tools[${String(i)}]`;
    if (tool.length === 0 || tool === WILDCARD_TOOL)
      errors.push({ path, message: 'must be a non-empty tool name other than "*"' });
    else if (seen.has(tool)) errors.push({ path, message: `duplicate tool "${tool}"` });
    seen.add(tool);
  });

  const config = input.config ?? {};
  if (!isRecord(config)) errors.push({ path: "config", message: "must be an object" });

  if (errors.length > 0 || !isKind(input.kind)) return err(errors);
  return ok({
    id: deps.id(),
    officeId: input.officeId,
    kind: input.kind,
    name,
    config: { ...config },
    secretRef: input.secretRef ?? null,
    tools: [...input.tools],
    enabled: input.enabled ?? true,
    createdAt: deps.now(),
  });
}

/** Checks grants against the office's connectors; wildcards are always valid. */
export function validateToolGrants(
  grants: readonly ToolGrant[],
  connectors: readonly Connector[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  grants.forEach((g, i) => {
    const connector = connectors.find((c) => c.id === g.connectorId);
    if (!connector) {
      errors.push({
        path: `toolGrants[${String(i)}].connectorId`,
        message: `unknown connector "${g.connectorId}"`,
      });
      return;
    }
    if (g.tool !== WILDCARD_TOOL && !connector.tools.includes(g.tool)) {
      errors.push({
        path: `toolGrants[${String(i)}].tool`,
        message: `connector "${connector.name}" has no tool "${g.tool}"`,
      });
    }
  });
  return errors;
}

/** Every concrete tool the employee may call: union of department and employee grants on enabled connectors. */
export function resolveToolAccess(ctx: GrantContext): ResolvedTool[] {
  const out: ResolvedTool[] = [];
  const seen = new Set<string>();
  for (const connector of ctx.connectors) {
    if (!connector.enabled) continue;
    const grants = [...ctx.departmentGrants, ...ctx.employeeGrants].filter(
      (g) => g.connectorId === connector.id,
    );
    if (grants.length === 0) continue;
    const all = grants.some((g) => g.tool === WILDCARD_TOOL);
    for (const tool of connector.tools) {
      if (!all && !grants.some((g) => g.tool === tool)) continue;
      const key = `${connector.id}.${tool}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ connectorId: connector.id, tool });
    }
  }
  return out;
}

export function canCallTool(ctx: GrantContext, connectorId: string, tool: string): ToolDecision {
  const connector = ctx.connectors.find((c) => c.id === connectorId);
  if (!connector) return { allowed: false, reason: "unknown_connector" };
  if (!connector.enabled) return { allowed: false, reason: "connector_disabled" };
  if (!connector.tools.includes(tool)) return { allowed: false, reason: "unknown_tool" };
  const granted = resolveToolAccess(ctx).some(
    (t) => t.connectorId === connectorId && t.tool === tool,
  );
  return granted ? { allowed: true } : { allowed: false, reason: "not_granted" };
}
