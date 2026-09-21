import { relationalStoreContract } from "../testing/relational-contract.js";
import { InMemoryRelationalStore } from "./in-memory.js";

relationalStoreContract("in-memory", {
  create: () => Promise.resolve(new InMemoryRelationalStore()),
  destroy: () => Promise.resolve(),
});
