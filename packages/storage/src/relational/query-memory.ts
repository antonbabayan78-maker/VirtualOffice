/**
 * In-memory implementation of ListQuery semantics (filter, order, cursor, page).
 * Used by the in-memory adapter and by SQL adapters that lack jsonQuery, so every
 * adapter paginates identically.
 */
import { compareValues, decodeCursor, encodeCursor } from "./cursor.js";
import { DEFAULT_PAGE_SIZE, type Entity, type ListQuery, type Page, type Where } from "./types.js";

export function matchesWhere<T extends Entity>(entity: T, where: Where<T> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => (entity as Record<string, unknown>)[k] === v);
}

/** Applies the whole query to `all` and returns a page of detached clones. Throws on an invalid cursor. */
export function applyListQuery<T extends Entity>(
  all: readonly T[],
  query: ListQuery<T>,
  maxPageSize: number,
): Page<T> {
  const field = query.orderBy?.field ?? "id";
  const dir = query.orderBy?.direction === "desc" ? -1 : 1;
  const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_PAGE_SIZE, maxPageSize));
  const valueOf = (e: T): unknown => (e as Record<string, unknown>)[field];

  const sorted = all
    .filter((e) => matchesWhere(e, query.where))
    .sort((a, b) => compareValues(valueOf(a), valueOf(b)) * dir || compareValues(a.id, b.id) * dir);

  let start = 0;
  if (query.cursor !== undefined) {
    const after = decodeCursor(query.cursor);
    start = sorted.findIndex(
      (e) => (compareValues(valueOf(e), after.v) * dir || compareValues(e.id, after.id) * dir) > 0,
    );
    if (start === -1) start = sorted.length;
  }

  const items = sorted.slice(start, start + limit).map((e) => structuredClone(e));
  const last = items.at(-1);
  const nextCursor =
    start + limit < sorted.length && last ? encodeCursor({ v: valueOf(last), id: last.id }) : null;
  return { items, nextCursor };
}
