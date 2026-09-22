import { describe, expect, it } from "vitest";
import { InMemoryRelationalStore } from "../relational/in-memory.js";
import {
  CAPABILITY_NAMES,
  describeFallbacks,
  NO_CAPABILITIES,
  type StoreCapabilities,
} from "./capabilities.js";
import {
  InMemoryBlobStore,
  InMemoryCoordinationStore,
  InMemoryEventStore,
  InMemoryVectorStore,
} from "./in-memory.js";

describe("capabilities", () => {
  it("lists the seven capability flags", () => {
    expect(CAPABILITY_NAMES).toEqual([
      "transactions",
      "jsonQuery",
      "fullText",
      "vector",
      "partitioning",
      "listenNotify",
      "upsert",
    ]);
    for (const name of CAPABILITY_NAMES) expect(NO_CAPABILITIES[name]).toBe(false);
  });

  it("every in-memory adapter reports its capabilities", () => {
    expect(new InMemoryRelationalStore().capabilities).toEqual<StoreCapabilities>({
      transactions: true,
      jsonQuery: true,
      fullText: false,
      vector: false,
      partitioning: false,
      listenNotify: false,
      upsert: true,
    });
    expect(new InMemoryVectorStore().capabilities.vector).toBe(false);
    expect(new InMemoryEventStore().capabilities.partitioning).toBe(false);
    expect(new InMemoryCoordinationStore().capabilities.listenNotify).toBe(false);
    expect(new InMemoryBlobStore().capabilities).toEqual(NO_CAPABILITIES);
  });

  it("describes which fallback is active for each missing capability", () => {
    const lines = describeFallbacks({ ...NO_CAPABILITIES, transactions: true });
    expect(lines).toEqual([
      "jsonQuery: filtering and sorting on non-promoted fields happens in memory after a promoted-column query",
      "fullText: keyword search scans documents in memory",
      "vector: similarity search is brute-force cosine over the office's vectors",
      "partitioning: events are stored in time-bucketed tables (one per month)",
      "listenNotify: change feeds poll the event store with backoff",
      "upsert: writes use a read-then-write inside a transaction",
    ]);
    expect(
      describeFallbacks({ ...NO_CAPABILITIES, transactions: true, jsonQuery: true, upsert: true }),
    ).toHaveLength(4);
  });
});
