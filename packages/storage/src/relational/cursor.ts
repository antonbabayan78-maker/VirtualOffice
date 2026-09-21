/**
 * Opaque, adapter-neutral pagination cursors: base64url JSON of the last item's
 * sort value and id. Dates are tagged so they survive the round-trip.
 */
export interface CursorPayload {
  readonly v: unknown;
  readonly id: string;
}

interface Wire {
  v: unknown;
  d?: 1;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  const wire: Wire =
    payload.v instanceof Date
      ? { v: payload.v.toISOString(), d: 1, id: payload.id }
      : { v: payload.v, id: payload.id };
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload {
  let wire: unknown;
  try {
    wire = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid cursor");
  }
  if (
    typeof wire !== "object" ||
    wire === null ||
    typeof (wire as Wire).id !== "string" ||
    !("v" in wire)
  ) {
    throw new Error("invalid cursor");
  }
  const w = wire as Wire;
  return { v: w.d === 1 && typeof w.v === "string" ? new Date(w.v) : w.v, id: w.id };
}

/** Total order over sort values: numbers, Dates and strings by code unit; null/undefined first. */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = sortable(a);
  const sb = sortable(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function sortable(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return "";
}
