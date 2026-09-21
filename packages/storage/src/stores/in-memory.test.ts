import { blobStoreContract } from "../testing/blob-contract.js";
import { coordinationStoreContract } from "../testing/coordination-contract.js";
import { eventStoreContract } from "../testing/event-contract.js";
import { vectorStoreContract } from "../testing/vector-contract.js";
import {
  InMemoryBlobStore,
  InMemoryCoordinationStore,
  InMemoryEventStore,
  InMemoryVectorStore,
} from "./in-memory.js";

vectorStoreContract("in-memory", {
  create: () => Promise.resolve(new InMemoryVectorStore()),
  destroy: () => Promise.resolve(),
});
eventStoreContract("in-memory", {
  create: () => Promise.resolve(new InMemoryEventStore()),
  destroy: () => Promise.resolve(),
});
coordinationStoreContract("in-memory", {
  create: (clock) => Promise.resolve(new InMemoryCoordinationStore({ clock })),
  destroy: () => Promise.resolve(),
});
blobStoreContract("in-memory", {
  create: () => Promise.resolve(new InMemoryBlobStore()),
  destroy: () => Promise.resolve(),
});
