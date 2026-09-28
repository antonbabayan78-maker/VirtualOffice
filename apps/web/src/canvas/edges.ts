/**
 * The arrows, as React Flow wants them.
 *
 * Kept apart from the canvas component so two rules can be tested without a
 * DOM: a head on the far end always and on the near end only when the work goes
 * both ways, and which side of each room the line should leave and arrive on.
 *
 * The side matters more than it sounds. Every edge anchored right-to-left makes
 * a department below another reachable only by a line that loops around the
 * building, and a dozen of those is an unreadable canvas.
 */
import { MarkerType, type Edge, type EdgeMarker } from "@xyflow/react";
import type { DepartmentLink } from "../office/links.js";

/** An arrowhead the colour of the line it ends, at a readable size. */
export const HEAD: EdgeMarker = {
  type: MarkerType.ArrowClosed,
  width: 18,
  height: 18,
  color: "var(--color-ink-muted)",
};

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Which sides a line between these two rooms should use. */
function sides(from: Box | undefined, to: Box | undefined): { source: string; target: string } {
  // Nothing known about where they are: across is the safe assumption, and a
  // sensible default beats an edge React Flow refuses to anchor.
  if (from === undefined || to === undefined) return { source: "right-out", target: "left-in" };

  // From the middle of each room: a corner comparison sends the arrow the wrong
  // way as soon as the rooms are different sizes.
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { source: "right-out", target: "left-in" }
      : { source: "left-out", target: "right-in" };
  }
  return dy >= 0
    ? { source: "bottom-out", target: "top-in" }
    : { source: "top-out", target: "bottom-in" };
}

export function edgesFrom(
  links: readonly DepartmentLink[],
  boxes: Readonly<Record<string, Box>>,
): Edge[] {
  return links.map((link) => {
    const handles = sides(boxes[link.from], boxes[link.to]);
    return {
      id: link.id,
      source: link.from,
      target: link.to,
      sourceHandle: handles.source,
      targetHandle: handles.target,
      label: link.label,
      markerEnd: HEAD,
      // Two heads is how the canvas says the work goes both ways; two arrows
      // between the same pair would say it illegibly.
      ...(link.twoWay ? { markerStart: HEAD } : {}),
      style: { stroke: "var(--color-ink-muted)" },
      labelStyle: { fill: "var(--color-ink-muted)", fontSize: 11 },
      labelBgStyle: { fill: "var(--color-surface)" },
      labelBgPadding: [4, 2] as [number, number],
    };
  });
}
