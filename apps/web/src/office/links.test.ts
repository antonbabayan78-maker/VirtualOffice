import { describe, expect, it } from "vitest";
import type { Connection, ConnectionId, ConnectionKind, DepartmentId, OfficeId } from "@vo/core";
import { linksFrom, LINK_LABELS } from "./links.js";

const officeId = "office-1" as OfficeId;
const at = new Date("2026-09-28T09:00:00Z");
let n = 0;

const link = (from: string, to: string, kind: ConnectionKind = "handoff"): Connection => ({
  id: `conn-${String((n += 1))}` as ConnectionId,
  officeId,
  fromId: from as DepartmentId,
  toId: to as DepartmentId,
  kind,
  enabled: true,
  rules: {},
  createdAt: at,
});

describe("drawing the connections between departments", () => {
  it("points an arrow the way the work goes", () => {
    const [drawn] = linksFrom([link("product", "design")]);
    expect(drawn).toMatchObject({ from: "product", to: "design", twoWay: false });
  });

  it("points both ways when each department sends to the other", () => {
    const drawn = linksFrom([link("design", "engineering"), link("engineering", "design")]);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.twoWay).toBe(true);
  });

  it("keeps both connections behind the one arrow, so either can be edited", () => {
    const there = link("design", "engineering");
    const back = link("engineering", "design");
    const [drawn] = linksFrom([there, back]);

    expect(drawn?.connectionIds).toEqual([there.id, back.id]);
  });

  it("points both ways for a kind that has no direction at all", () => {
    // Collaboration is mutual by definition: A collaborates with B is B with A.
    const [drawn] = linksFrom([link("product", "design", "collaborates")]);
    expect(drawn?.twoWay).toBe(true);
  });

  it("does not merge two different kinds between the same pair", () => {
    // A hands work to B and B escalates to A: two different relationships that
    // happen to share a pair, not one relationship that runs both ways.
    const drawn = linksFrom([
      link("engineering", "operations", "handoff"),
      link("operations", "engineering", "escalates_to"),
    ]);

    expect(drawn).toHaveLength(2);
    expect(drawn.every((one) => !one.twoWay)).toBe(true);
  });

  it("draws every pair once, however many departments there are", () => {
    const drawn = linksFrom([
      link("product", "design"),
      link("design", "engineering"),
      link("engineering", "operations"),
    ]);
    expect(drawn.map((one) => `${one.from}->${one.to}`)).toEqual([
      "product->design",
      "design->engineering",
      "engineering->operations",
    ]);
  });

  it("ignores a department connected to itself, which no arrow can show", () => {
    expect(linksFrom([link("product", "product")])).toEqual([]);
  });

  it("gives each arrow a stable id, so React does not redraw the lot on a change", () => {
    const connections = [link("product", "design"), link("design", "product")];
    const first = linksFrom(connections);
    const again = linksFrom([...connections].reverse());

    expect(first[0]?.id).toBe(again[0]?.id);
  });

  it("has a plain-English name for every kind a connection can be", () => {
    const kinds: ConnectionKind[] = [
      "reports_to",
      "collaborates",
      "handoff",
      "reviews",
      "escalates_to",
    ];
    for (const kind of kinds) expect(LINK_LABELS[kind]).toMatch(/\w/);
  });

  it("labels an arrow with what the relationship is", () => {
    const [drawn] = linksFrom([link("product", "design", "handoff")]);
    expect(drawn?.label).toBe(LINK_LABELS.handoff);
  });
});
