/**
 * Month buckets: the portable fallback for native table partitioning. Adapters
 * without partitioning keep one table per UTC month and query the union.
 */
export type Bucket = string; // "YYYY_MM"

export function bucketFor(at: Date): Bucket {
  return `${String(at.getUTCFullYear())}_${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function bucketTableName(base: string, bucket: Bucket): string {
  return `${base}_${bucket}`;
}

export function parseBucketTableName(base: string, table: string): Bucket | null {
  const m = new RegExp(`^${base}_(\\d{4}_\\d{2})$`).exec(table);
  return m?.[1] ?? null;
}

/** Buckets touched by [from, to), oldest first. Empty when the range is empty. */
export function bucketsBetween(from: Date, to: Date): Bucket[] {
  if (to.getTime() <= from.getTime()) return [];
  const out: Bucket[] = [];
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  const lastInclusive = new Date(to.getTime() - 1);
  const endYear = lastInclusive.getUTCFullYear();
  const endMonth = lastInclusive.getUTCMonth();
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${String(year)}_${String(month + 1).padStart(2, "0")}`);
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return out;
}
