import { describe, expect, it } from "vitest";
import { estimateTokens } from "@vo/llm";
import { FIND_TOOL_NAME, LazyToolset } from "./lazy-toolset.js";
import { ToolCatalog, type CatalogTool } from "./tool-catalog.js";

function bigTool(i: number): CatalogTool {
  const props: Record<string, unknown> = {};
  for (let p = 0; p < 8; p++) {
    props[`param_${String(p)}`] = {
      type: "string",
      description: `Parameter ${String(p)} of tool ${String(i)}, used to control behaviour in detail.`,
    };
  }
  return {
    name: `tool_${String(i).padStart(2, "0")}`,
    description: `Tool number ${String(i)} that does something specific with ${i % 2 === 0 ? "pull requests" : "spreadsheets"}`,
    connectorId: i % 2 === 0 ? "github" : "sheets",
    tags: i % 2 === 0 ? ["pr"] : ["sheet"],
    inputSchema: { type: "object", properties: props, required: ["param_0"] },
  };
}

const catalog = new ToolCatalog(Array.from({ length: 50 }, (_, i) => bigTool(i)));
const tokensOf = (value: unknown): number => estimateTokens(JSON.stringify(value));

describe("LazyToolset", () => {
  it("starts with only the find_tool meta-tool loaded and an index in the system context", () => {
    const set = new LazyToolset(catalog);
    expect(set.loaded().map((t) => t.name)).toEqual([FIND_TOOL_NAME]);
    const index = set.indexText();
    expect(index).toContain("tool_00 (github)");
    expect(index).toContain("tool_49 (sheets)");
    expect(index).toContain(FIND_TOOL_NAME);
    expect(index).not.toContain("param_3");
  });

  it("keeps the context far smaller than loading every schema", () => {
    const set = new LazyToolset(catalog);
    const lazyTokens = estimateTokens(set.indexText()) + tokensOf(set.loaded());
    const eagerTokens = tokensOf(catalog.all());
    expect(lazyTokens).toBeLessThan(eagerTokens * 0.2);
    expect(set.contextTokens()).toEqual({
      index: estimateTokens(set.indexText()),
      loaded: tokensOf(set.loaded()),
    });
  });

  it("injects a full schema only after find_tool returns it", () => {
    const set = new LazyToolset(catalog);
    expect(set.isLoaded("tool_04")).toBe(false);
    const result = set.handleFindTool({ query: "pull requests", limit: 2 });
    expect(result.found.map((f) => f.name)).toEqual(["tool_00", "tool_02"]);
    expect(result.found[0]).toEqual({
      name: "tool_00",
      connectorId: "github",
      description: expect.stringContaining("Tool number 0") as string,
    });
    expect(set.loaded().map((t) => t.name)).toEqual([FIND_TOOL_NAME, "tool_00", "tool_02"]);
    expect(set.loaded().find((t) => t.name === "tool_00")?.inputSchema).toEqual(
      catalog.get("tool_00")?.inputSchema,
    );
    expect(set.isLoaded("tool_00")).toBe(true);
  });

  it("returns a helpful empty result for an unknown query and tolerates bad input", () => {
    const set = new LazyToolset(catalog);
    expect(set.handleFindTool({ query: "quantum flux" })).toEqual({
      found: [],
      hint: expect.stringContaining("No tool matched") as string,
    });
    expect(set.handleFindTool({})).toEqual({
      found: [],
      hint: expect.stringContaining("query") as string,
    });
    expect(set.handleFindTool({ query: "pull requests", limit: 0 }).found).toHaveLength(1);
  });

  it("evicts the least recently used tools beyond the cap and keeps always-loaded ones", () => {
    const set = new LazyToolset(catalog, { alwaysLoaded: ["tool_49"], maxLoaded: 2 });
    expect(set.loaded().map((t) => t.name)).toEqual([FIND_TOOL_NAME, "tool_49"]);
    set.activate(["tool_00", "tool_02"]);
    set.activate(["tool_04"]);
    expect(set.loaded().map((t) => t.name)).toEqual([
      FIND_TOOL_NAME,
      "tool_49",
      "tool_02",
      "tool_04",
    ]);
    set.touch("tool_02");
    set.activate(["tool_06"]);
    expect(set.loaded().map((t) => t.name)).toEqual([
      FIND_TOOL_NAME,
      "tool_49",
      "tool_02",
      "tool_06",
    ]);
    expect(() => {
      set.activate(["nope"]);
    }).toThrow(/unknown tool "nope"/);
    expect(() => new LazyToolset(catalog, { alwaysLoaded: ["nope"] })).toThrow(
      /unknown tool "nope"/,
    );
  });

  it("recognises and executes find_tool calls as tool results", () => {
    const set = new LazyToolset(catalog);
    const call = {
      type: "tool_use" as const,
      id: "toolu_1",
      name: FIND_TOOL_NAME,
      input: { query: "spreadsheets", limit: 1 },
    };
    expect(set.isFindTool(call)).toBe(true);
    expect(set.isFindTool({ ...call, name: "tool_00" })).toBe(false);
    const result = set.execute(call);
    expect(result).toEqual({
      type: "tool_result",
      toolUseId: "toolu_1",
      content: expect.stringContaining('"tool_01"') as string,
    });
    expect(JSON.parse(result.content) as unknown).toMatchObject({ found: [{ name: "tool_01" }] });
    expect(set.isLoaded("tool_01")).toBe(true);
    expect(() => set.execute({ ...call, name: "tool_00" })).toThrow(/not the find_tool/);
  });

  it("exposes the meta-tool definition with a strict schema", () => {
    const def = new LazyToolset(catalog).loaded()[0];
    expect(def?.name).toBe(FIND_TOOL_NAME);
    expect(def?.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
      additionalProperties: false,
    });
  });
});
