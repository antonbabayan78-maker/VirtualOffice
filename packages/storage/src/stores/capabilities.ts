/**
 * Capability flags every store adapter reports. Missing capabilities never break
 * a feature; they select a documented fallback (plan §4.1 rule 3).
 */
export const CAPABILITY_NAMES = [
  "transactions",
  "jsonQuery",
  "fullText",
  "vector",
  "partitioning",
  "listenNotify",
  "upsert",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export type StoreCapabilities = Readonly<Record<CapabilityName, boolean>>;

export const NO_CAPABILITIES: StoreCapabilities = {
  transactions: false,
  jsonQuery: false,
  fullText: false,
  vector: false,
  partitioning: false,
  listenNotify: false,
  upsert: false,
};

const FALLBACKS: Record<Exclude<CapabilityName, "transactions">, string> = {
  jsonQuery:
    "filtering and sorting on non-promoted fields happens in memory after a promoted-column query",
  fullText: "keyword search scans documents in memory",
  vector: "similarity search is brute-force cosine over the office's vectors",
  partitioning: "events are stored in time-bucketed tables (one per month)",
  listenNotify: "change feeds poll the event store with backoff",
  upsert: "writes use a read-then-write inside a transaction",
};

/** Human-readable list of the fallbacks active for a store, for logs and the storage settings UI. */
export function describeFallbacks(capabilities: StoreCapabilities): string[] {
  return (Object.keys(FALLBACKS) as (keyof typeof FALLBACKS)[])
    .filter((name) => !capabilities[name])
    .map((name) => `${name}: ${FALLBACKS[name]}`);
}
