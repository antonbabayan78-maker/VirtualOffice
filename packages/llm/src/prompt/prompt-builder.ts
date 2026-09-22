/**
 * Cache-aware prompt builder (plan §6.3).
 *
 * Provider caches match on a byte-identical prefix rendered as tools, then system,
 * then messages. So: tools are sorted by name with canonical (key-sorted)
 * schemas, stable system content (identity, rules, skills index) comes first
 * and carries a cache breakpoint, and anything that changes per run (dates,
 * task context) goes in a dynamic block after it. The stable prefix is hashed
 * so a test or a dashboard can prove it did not move between runs.
 */
import { createHash } from "node:crypto";
import { estimateTokens } from "../provider/tokens.js";
import {
  systemText,
  type Message,
  type SystemBlock,
  type ToolDefinition,
} from "../provider/types.js";

export { systemText };

export interface PromptLayers {
  readonly system: {
    /** Content that must not change between runs of the same employee. */
    readonly stable: readonly string[];
    /** Per-run context; rendered after the stable block. */
    readonly dynamic?: readonly string[];
  };
  readonly tools: readonly ToolDefinition[];
  readonly messages: readonly Message[];
}

export interface BuiltPrompt {
  readonly system: readonly SystemBlock[];
  readonly tools: readonly ToolDefinition[];
  readonly messages: readonly Message[];
  /** Canonical serialization of the cacheable prefix (tools + stable system). */
  readonly stablePrefix: string;
  /** sha256 of stablePrefix. */
  readonly prefixHash: string;
  /** Estimated tokens in the stable prefix. */
  readonly prefixTokens: number;
}

const BLOCK_SEPARATOR = "\n\n";

/** Recursively sorts object keys so equal schemas serialize identically. Array order is kept. */
export function canonicalizeSchema<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => canonicalizeSchema(v)) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalizeSchema((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

export function buildPrompt(layers: PromptLayers): BuiltPrompt {
  const stable = layers.system.stable.map((s) => s.trim()).filter((s) => s.length > 0);
  if (stable.length === 0)
    throw new Error("buildPrompt: at least one non-empty stable system block is required");

  const seen = new Set<string>();
  for (const t of layers.tools) {
    if (seen.has(t.name)) throw new Error(`buildPrompt: duplicate tool "${t.name}"`);
    seen.add(t.name);
  }
  const sorted = [...layers.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: canonicalizeSchema(t.inputSchema),
    }));
  const tools: ToolDefinition[] = sorted.map((t, i) =>
    i === sorted.length - 1 ? { ...t, cache: true } : t,
  );

  const dynamic = (layers.system.dynamic ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  const system: SystemBlock[] = [{ text: stable.join(BLOCK_SEPARATOR), cache: true }];
  if (dynamic.length > 0) system.push({ text: dynamic.join(BLOCK_SEPARATOR), cache: false });

  const stablePrefix = JSON.stringify({
    tools: sorted.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    system: stable.join(BLOCK_SEPARATOR),
  });
  const prefixHash = createHash("sha256").update(stablePrefix).digest("hex");

  return {
    system,
    tools,
    messages: layers.messages,
    stablePrefix,
    prefixHash,
    prefixTokens: estimateTokens(stablePrefix),
  };
}
