import { describe, expect, it } from "vitest";
import { ToolCatalog, type CatalogTool } from "./tool-catalog.js";

const tool = (
  name: string,
  description: string,
  connectorId = "github",
  tags: string[] = [],
): CatalogTool => ({
  name,
  description,
  connectorId,
  tags,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: `The ${name} id` } },
    required: ["id"],
  },
});

const tools = [
  tool("create_review", "Create a pull request review with comments", "github", ["review", "pr"]),
  tool("get_diff", "Fetch the diff of a pull request", "github", ["pr"]),
  tool("post_message", "Post a message to a Slack channel", "slack", ["chat"]),
  tool("search_issues", "Search Jira issues by JQL", "jira", ["search"]),
];

describe("ToolCatalog", () => {
  it("renders a one-line index per tool, sorted by name", () => {
    const catalog = new ToolCatalog(tools);
    expect(catalog.size).toBe(4);
    expect(catalog.indexLines()).toEqual([
      "create_review (github): Create a pull request review with comments",
      "get_diff (github): Fetch the diff of a pull request",
      "post_message (slack): Post a message to a Slack channel",
      "search_issues (jira): Search Jira issues by JQL",
    ]);
    expect(catalog.index()).toBe(catalog.indexLines().join("\n"));
  });

  it("looks tools up by name and rejects duplicates", () => {
    const catalog = new ToolCatalog(tools);
    expect(catalog.get("get_diff")?.connectorId).toBe("github");
    expect(catalog.get("nope")).toBeNull();
    expect(() => new ToolCatalog([...tools, tool("get_diff", "again")])).toThrow(
      /duplicate tool "get_diff"/,
    );
  });

  it("finds tools by name, description words and tags, best matches first", () => {
    const catalog = new ToolCatalog(tools);
    expect(catalog.find("get_diff").map((t) => t.name)).toEqual(["get_diff"]);
    expect(catalog.find("pull request").map((t) => t.name)).toEqual(["create_review", "get_diff"]);
    expect(catalog.find("slack message").map((t) => t.name)[0]).toBe("post_message");
    expect(catalog.find("search").map((t) => t.name)).toEqual(["search_issues"]);
    expect(catalog.find("PR")[0]?.name).toBe("create_review");
    expect(catalog.find("")).toEqual([]);
    expect(catalog.find("zzz")).toEqual([]);
  });

  it("respects the result limit", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      tool(`tool_${String(i)}`, "Handles widgets", "w"),
    );
    expect(new ToolCatalog(many).find("widgets", 3)).toHaveLength(3);
  });
});
