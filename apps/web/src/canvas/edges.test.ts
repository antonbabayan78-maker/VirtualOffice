import { describe, expect, it } from "vitest";
import type { ConnectionId } from "@vo/core";
import type { DepartmentLink } from "../office/links.js";
import { connectionBehind, edgesFrom, HEAD, type Box } from "./edges.js";

const link = (overrides: Partial<DepartmentLink> = {}): DepartmentLink => ({
  id: "a~b~handoff",
  from: "a",
  to: "b",
  kind: "handoff",
  twoWay: false,
  label: "hands off to",
  connectionIds: ["conn-1" as ConnectionId],
  enabled: true,
  ...overrides,
});

const room = (x: number, y: number): Box => ({ x, y, width: 400, height: 240 });
/** a is top-left; the others are placed relative to it. */
const boxes = (b: Box): Readonly<Record<string, Box>> => ({ a: room(0, 0), b });

describe("handing the arrows to the canvas", () => {
  it("draws from the department the work leaves to the one it reaches", () => {
    const [edge] = edgesFrom([link()], boxes(room(600, 0)));
    expect(edge).toMatchObject({ source: "a", target: "b" });
  });

  it("puts a head on the far end, so the direction is visible", () => {
    expect(edgesFrom([link()], boxes(room(600, 0)))[0]?.markerEnd).toEqual(HEAD);
  });

  it("leaves the near end bare when the work only goes one way", () => {
    expect(edgesFrom([link()], boxes(room(600, 0)))[0]?.markerStart).toBeUndefined();
  });

  it("puts a head on both ends when the work goes both ways", () => {
    const [edge] = edgesFrom([link({ twoWay: true })], boxes(room(600, 0)));
    expect(edge?.markerStart).toEqual(HEAD);
    expect(edge?.markerEnd).toEqual(HEAD);
  });

  it("says what the relationship is, so an arrow is not a mystery line", () => {
    expect(edgesFrom([link()], boxes(room(600, 0)))[0]?.label).toBe("hands off to");
  });

  it("keeps the link's id, so an arrow is not redrawn on every change", () => {
    expect(edgesFrom([link()], boxes(room(600, 0)))[0]?.id).toBe("a~b~handoff");
  });
});

describe("choosing which side an arrow leaves and arrives on", () => {
  it("goes out the right and in the left for a department to the right", () => {
    const [edge] = edgesFrom([link()], boxes(room(600, 0)));
    expect(edge?.sourceHandle).toBe("right-out");
    expect(edge?.targetHandle).toBe("left-in");
  });

  it("goes out the left and in the right for a department to the left", () => {
    const [edge] = edgesFrom([link()], boxes(room(-600, 0)));
    expect(edge?.sourceHandle).toBe("left-out");
    expect(edge?.targetHandle).toBe("right-in");
  });

  it("goes out the bottom and in the top for a department below", () => {
    const [edge] = edgesFrom([link()], boxes(room(0, 600)));
    expect(edge?.sourceHandle).toBe("bottom-out");
    expect(edge?.targetHandle).toBe("top-in");
  });

  it("goes out the top and in the bottom for a department above", () => {
    const [edge] = edgesFrom([link()], boxes(room(0, -600)));
    expect(edge?.sourceHandle).toBe("top-out");
    expect(edge?.targetHandle).toBe("bottom-in");
  });

  it("takes the shorter way round when a department is both across and below", () => {
    // Mostly across: the line should run sideways, not up and over.
    const [edge] = edgesFrom([link()], boxes(room(900, 200)));
    expect(edge?.sourceHandle).toBe("right-out");
  });

  it("falls back to across when it is told nothing about where they are", () => {
    const [edge] = edgesFrom([link()], {});
    expect(edge?.sourceHandle).toBe("right-out");
    expect(edge?.targetHandle).toBe("left-in");
  });

  it("measures from the middle of each room, not its corner", () => {
    // b starts further right but is wide enough that its centre sits to the
    // left of a's; a corner comparison would send the arrow the wrong way.
    const wide: Box = { x: 100, y: 0, width: 40, height: 240 };
    const [edge] = edgesFrom([link()], { a: room(0, 0), b: wide });
    expect(edge?.sourceHandle).toBe("left-out");
  });
});

describe("an arrow that is switched off", () => {
  const off = () => edgesFrom([link({ enabled: false })], boxes(room(600, 0)))[0];

  it("is drawn broken, so it does not look like it is in force", () => {
    expect(off()?.style?.strokeDasharray).toBeTruthy();
  });

  it("is drawn faintly", () => {
    const on = edgesFrom([link()], boxes(room(600, 0)))[0];
    expect(off()?.style?.opacity).toBeDefined();
    expect(on?.style?.opacity).toBeUndefined();
  });

  it("says so in the label, since a dashed line alone is a guess", () => {
    expect(off()?.label).toMatch(/off/i);
  });

  it("still points the way the work would go if it were on", () => {
    expect(off()).toMatchObject({ source: "a", target: "b" });
  });
});

describe("which connection an arrow stands for", () => {
  it("is the one the arrow was drawn from", () => {
    const drawn = [link({ connectionIds: ["conn-a" as ConnectionId] })];
    expect(connectionBehind(drawn, "a~b~handoff")).toBe("conn-a");
  });

  it("is the first when an arrow stands for a pair going both ways", () => {
    const drawn = [
      link({
        twoWay: true,
        connectionIds: ["conn-there" as ConnectionId, "conn-back" as ConnectionId],
      }),
    ];
    expect(connectionBehind(drawn, "a~b~handoff")).toBe("conn-there");
  });

  it("is nothing when the arrow is not one the canvas knows", () => {
    expect(connectionBehind([link()], "not~an~arrow")).toBeNull();
  });

  it("is nothing when an arrow somehow stands for no connection at all", () => {
    expect(connectionBehind([link({ connectionIds: [] })], "a~b~handoff")).toBeNull();
  });
});
