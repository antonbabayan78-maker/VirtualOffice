/**
 * Tool catalog: every tool an employee may call, with a one-line index for the
 * prompt and keyword search so the model can find a tool before loading it.
 */
import type { ToolDefinition } from "@vo/llm";

export interface CatalogTool extends ToolDefinition {
  readonly connectorId: string;
  readonly tags?: readonly string[];
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class ToolCatalog {
  private readonly tools: readonly CatalogTool[];
  private readonly lookup = new Map<string, CatalogTool>();

  constructor(tools: readonly CatalogTool[]) {
    for (const t of tools) {
      if (this.lookup.has(t.name)) throw new Error(`duplicate tool "${t.name}"`);
      this.lookup.set(t.name, t);
    }
    this.tools = [...tools].sort(byName);
  }

  get size(): number {
    return this.tools.length;
  }

  all(): readonly CatalogTool[] {
    return this.tools;
  }

  get(name: string): CatalogTool | null {
    return this.lookup.get(name) ?? null;
  }

  indexLines(): string[] {
    return this.tools.map((t) => `${t.name} (${t.connectorId}): ${t.description}`);
  }

  index(): string {
    return this.indexLines().join("\n");
  }

  /** Keyword search over name, tags and description; exact name matches rank first. */
  find(query: string, limit = 5): CatalogTool[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (terms.length === 0) return [];
    const scored = this.tools
      .map((tool) => {
        const name = tool.name.toLowerCase();
        const description = tool.description.toLowerCase();
        const tags = (tool.tags ?? []).map((t) => t.toLowerCase());
        let score = 0;
        for (const term of terms) {
          if (name === term) score += 100;
          else if (name.includes(term)) score += 10;
          if (tags.includes(term)) score += 8;
          if (new RegExp(`\\b${escapeRegExp(term)}\\b`).test(description)) score += 3;
        }
        return { tool, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || byName(a.tool, b.tool));
    return scored.slice(0, Math.max(0, limit)).map((s) => s.tool);
  }
}
