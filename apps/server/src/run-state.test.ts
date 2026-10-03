import { describe, expect, it } from "vitest";
import { InMemoryBlobStore } from "@vo/storage";
import { blobRunDecisions } from "./run-state.js";

const decisions = () => blobRunDecisions(new InMemoryBlobStore());

const approved = (key: string) =>
  ({ key, decision: "approved" as const, decidedBy: "owner-1" }) as const;

describe("what a person decided about a held call", () => {
  it("answers nothing for a run nobody has decided anything about", async () => {
    expect(await decisions().list("task-1")).toEqual([]);
  });

  it("remembers one, so a resumed run can answer the call without asking again", async () => {
    const store = decisions();

    await store.record("task-1", approved("call-1"));

    expect(await store.list("task-1")).toEqual([approved("call-1")]);
  });

  it("keeps them apart by task, since two runs may be waiting at once", async () => {
    const store = decisions();

    await store.record("task-1", approved("call-1"));
    await store.record("task-2", approved("call-9"));

    expect(await store.list("task-1")).toEqual([approved("call-1")]);
    expect(await store.list("task-2")).toEqual([approved("call-9")]);
  });

  it("keeps several, because a run may be holding more than one call", async () => {
    const store = decisions();

    await store.record("task-1", approved("call-1"));
    await store.record("task-1", approved("call-2"));

    expect((await store.list("task-1")).map((one) => one.key)).toEqual(["call-1", "call-2"]);
  });

  it("holds one answer per call, so the same event twice is still one answer", async () => {
    // Delivery is at-least-once everywhere else in this office, and a decision
    // arriving twice must not read as two.
    const store = decisions();

    await store.record("task-1", approved("call-1"));
    await store.record("task-1", approved("call-1"));

    expect(await store.list("task-1")).toHaveLength(1);
  });

  it("lets a later answer about the same call replace the earlier one", async () => {
    const store = decisions();
    await store.record("task-1", approved("call-1"));

    await store.record("task-1", {
      key: "call-1",
      decision: "declined",
      decidedBy: "owner-1",
      reason: "changed my mind",
    });

    expect((await store.list("task-1"))[0]?.decision).toBe("declined");
  });

  it("forgets everything when the work moves on", async () => {
    const store = decisions();
    await store.record("task-1", approved("call-1"));

    expect(await store.clear("task-1")).toBe(true);
    expect(await store.list("task-1")).toEqual([]);
  });

  it("has nothing to forget for a run that decided nothing", async () => {
    expect(await decisions().clear("task-1")).toBe(false);
  });

  it("reads a record it cannot make sense of as nothing decided", async () => {
    // Rather than throwing in the middle of a run: a decision nobody can read
    // is a decision nobody made, and the run asks again.
    const blobs = new InMemoryBlobStore();
    await blobs.put("runs/task-1.decisions.json", new TextEncoder().encode("{not json"));

    expect(await blobRunDecisions(blobs).list("task-1")).toEqual([]);
  });
});
