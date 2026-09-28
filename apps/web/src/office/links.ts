/**
 * Turning connections into arrows.
 *
 * Two departments that each send work to the other are one relationship drawn
 * with two heads, not two arrows overlapping — overlapping arrows between the
 * same pair are unreadable, and the office genuinely has one road between them
 * with traffic in both directions.
 *
 * Merging is per kind. A handoff one way and an escalation back is two
 * different relationships that happen to share a pair, and collapsing them
 * would claim the office works in a way it does not.
 */
import {
  UNDIRECTED_KINDS,
  type Connection,
  type ConnectionId,
  type ConnectionKind,
} from "@vo/core";

export const LINK_LABELS: Readonly<Record<ConnectionKind, string>> = {
  reports_to: "reports to",
  collaborates: "works with",
  handoff: "hands off to",
  reviews: "reviews",
  escalates_to: "escalates to",
  watches: "watches",
};

export interface DepartmentLink {
  /** Stable across a reorder: the pair and the kind, not the connection ids. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: ConnectionKind;
  readonly twoWay: boolean;
  /** False when every connection behind this arrow is switched off. */
  readonly enabled: boolean;
  readonly label: string;
  /** Every connection this arrow stands for, so either end can be edited. */
  readonly connectionIds: readonly ConnectionId[];
}

/** The pair, in a fixed order, so both directions land in the same bucket. */
const pairKey = (a: string, b: string, kind: string): string =>
  `${[a, b].sort().join("~")}~${kind}`;

export function linksFrom(connections: readonly Connection[]): readonly DepartmentLink[] {
  const byPair = new Map<string, Connection[]>();

  for (const connection of connections) {
    // A department connected to itself has no arrow to draw.
    if (connection.fromId === connection.toId) continue;
    const key = pairKey(connection.fromId, connection.toId, connection.kind);
    const found = byPair.get(key);
    if (found === undefined) byPair.set(key, [connection]);
    else found.push(connection);
  }

  return [...byPair.values()].flatMap((group) => {
    const [first] = group;
    // Cannot happen — a group only exists once something was put in it — but
    // proving it to the compiler is cheaper than an assertion that lies.
    if (first === undefined) return [];
    const twoWay =
      UNDIRECTED_KINDS.includes(first.kind) ||
      group.some((other) => other.fromId === first.toId && other.toId === first.fromId);

    return [
      {
        id: pairKey(first.fromId, first.toId, first.kind),
        from: first.fromId,
        to: first.toId,
        kind: first.kind,
        twoWay,
        // An arrow drawn from several connections is in force if any is.
        enabled: group.some((one) => one.enabled),
        label: LINK_LABELS[first.kind],
        connectionIds: group.map((one) => one.id),
      },
    ];
  });
}
