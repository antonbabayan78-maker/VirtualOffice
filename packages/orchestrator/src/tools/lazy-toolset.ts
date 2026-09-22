/**
 * Lazy tool loading (plan §6.4). The model's context holds a one-line index of
 * every available tool plus a single `find_tool` meta-tool. A tool's full JSON
 * schema is injected into the request only after find_tool has returned it, and
 * loaded tools are evicted least-recently-used beyond a cap.
 */
import { estimateTokens, type ContentBlock, type ToolDefinition } from "@vo/llm";
import type { CatalogTool, ToolCatalog } from "./tool-catalog.js";

export const FIND_TOOL_NAME = "find_tool";

export const FIND_TOOL_DEFINITION: ToolDefinition = {
  name: FIND_TOOL_NAME,
  description:
    "Look up tools from the index by keywords. Returns matching tools and loads their full definitions so you can call them next. Call this before using any tool that is not already available.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords describing what you need to do, e.g. 'post slack message'.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "Maximum number of tools to load (default 3).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export interface FoundTool {
  readonly name: string;
  readonly connectorId: string;
  readonly description: string;
}

export interface FindToolResult {
  readonly found: readonly FoundTool[];
  readonly hint?: string;
}

export interface LazyToolsetOptions {
  /** Tools whose full schema is always present. */
  readonly alwaysLoaded?: readonly string[];
  /** Maximum number of dynamically loaded tools kept at once (default 8). */
  readonly maxLoaded?: number;
  readonly defaultLimit?: number;
}

type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;
type ToolResult = Extract<ContentBlock, { type: "tool_result" }>;

export class LazyToolset {
  private readonly always: readonly CatalogTool[];
  /** Insertion order = least recently used first. */
  private readonly active = new Map<string, CatalogTool>();
  private readonly maxLoaded: number;
  private readonly defaultLimit: number;

  constructor(
    private readonly catalog: ToolCatalog,
    options: LazyToolsetOptions = {},
  ) {
    this.always = (options.alwaysLoaded ?? []).map((name) => this.require(name));
    this.maxLoaded = Math.max(1, options.maxLoaded ?? 8);
    this.defaultLimit = Math.max(1, options.defaultLimit ?? 3);
  }

  private require(name: string): CatalogTool {
    const tool = this.catalog.get(name);
    if (!tool) throw new Error(`unknown tool "${name}"`);
    return tool;
  }

  /** Text for the stable system block: the index plus how to load tools. */
  indexText(): string {
    return `Available tools (load one with ${FIND_TOOL_NAME} before calling it):\n${this.catalog.index()}`;
  }

  /** Tool definitions for the request: find_tool, always-loaded tools, then loaded tools (LRU first). */
  loaded(): ToolDefinition[] {
    const strip = (t: CatalogTool): ToolDefinition => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    });
    return [
      FIND_TOOL_DEFINITION,
      ...this.always.map(strip),
      ...[...this.active.values()].map(strip),
    ];
  }

  isLoaded(name: string): boolean {
    return this.always.some((t) => t.name === name) || this.active.has(name);
  }

  activate(names: readonly string[]): void {
    for (const name of names) {
      const tool = this.require(name);
      if (this.always.some((t) => t.name === name)) continue;
      this.active.delete(name);
      this.active.set(name, tool);
      while (this.active.size > this.maxLoaded) {
        const oldest = this.active.keys().next().value;
        if (oldest === undefined) break;
        this.active.delete(oldest);
      }
    }
  }

  /** Marks a loaded tool as recently used so it survives eviction. */
  touch(name: string): void {
    const tool = this.active.get(name);
    if (tool) {
      this.active.delete(name);
      this.active.set(name, tool);
    }
  }

  handleFindTool(input: Readonly<Record<string, unknown>>): FindToolResult {
    const query = input["query"];
    if (typeof query !== "string" || query.trim().length === 0) {
      return {
        found: [],
        hint: "find_tool needs a non-empty string query describing what you want to do.",
      };
    }
    const rawLimit = input["limit"];
    const limit = Math.min(
      10,
      Math.max(
        1,
        typeof rawLimit === "number" && Number.isInteger(rawLimit) ? rawLimit : this.defaultLimit,
      ),
    );
    const matches = this.catalog.find(query, limit);
    if (matches.length === 0) {
      return {
        found: [],
        hint: `No tool matched "${query}". Try different words or pick a name from the tool index.`,
      };
    }
    this.activate(matches.map((m) => m.name));
    return {
      found: matches.map((m) => ({
        name: m.name,
        connectorId: m.connectorId,
        description: m.description,
      })),
    };
  }

  isFindTool(block: ToolUse): boolean {
    return block.name === FIND_TOOL_NAME;
  }

  /** Executes a find_tool call and returns the tool_result block for the next turn. */
  execute(block: ToolUse): ToolResult {
    if (!this.isFindTool(block))
      throw new Error(`"${block.name}" is not the ${FIND_TOOL_NAME} meta-tool`);
    return {
      type: "tool_result",
      toolUseId: block.id,
      content: JSON.stringify(this.handleFindTool(block.input)),
    };
  }

  contextTokens(): { index: number; loaded: number } {
    return {
      index: estimateTokens(this.indexText()),
      loaded: estimateTokens(JSON.stringify(this.loaded())),
    };
  }
}
