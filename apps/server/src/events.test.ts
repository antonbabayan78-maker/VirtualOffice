import { describe, expect, it } from "vitest";
import { OfficeEventLog } from "./events.js";

const log = (): OfficeEventLog => new OfficeEventLog({ now: () => 1_700_000_000_000 });

describe("the office event log", () => {
  it("numbers events from one, so a client can ask for everything", () => {
    const events = log();
    expect(events.publish("office-1", { kind: "department.created", id: "d1" }).offset).toBe(1);
    expect(events.publish("office-1", { kind: "department.created", id: "d2" }).offset).toBe(2);
  });

  it("numbers each office separately, so one busy office does not skew another", () => {
    const events = log();
    events.publish("office-1", { kind: "a" });
    events.publish("office-1", { kind: "b" });
    expect(events.publish("office-2", { kind: "c" }).offset).toBe(1);
  });

  it("replays everything after an offset a client already has", () => {
    const events = log();
    events.publish("office-1", { kind: "a" });
    events.publish("office-1", { kind: "b" });
    events.publish("office-1", { kind: "c" });
    expect(events.since("office-1", 1).map((e) => e.data["kind"])).toEqual(["b", "c"]);
  });

  it("replays the lot for a client that has seen nothing", () => {
    const events = log();
    events.publish("office-1", { kind: "a" });
    expect(events.since("office-1", 0)).toHaveLength(1);
  });

  it("replays nothing for a client that is up to date", () => {
    const events = log();
    events.publish("office-1", { kind: "a" });
    expect(events.since("office-1", 1)).toEqual([]);
  });

  it("replays nothing for an office nobody has written to", () => {
    expect(log().since("office-nobody", 0)).toEqual([]);
  });

  it("tells subscribers of that office, and nobody else", () => {
    const events = log();
    const heard: string[] = [];
    const elsewhere: string[] = [];
    events.subscribe("office-1", (event) => heard.push(String(event.data["kind"])));
    events.subscribe("office-2", (event) => elsewhere.push(String(event.data["kind"])));

    events.publish("office-1", { kind: "a" });
    expect(heard).toEqual(["a"]);
    expect(elsewhere).toEqual([]);
  });

  it("stops telling a subscriber that has gone", () => {
    const events = log();
    const heard: string[] = [];
    const stop = events.subscribe("office-1", (event) => heard.push(String(event.data["kind"])));
    events.publish("office-1", { kind: "a" });
    stop();
    events.publish("office-1", { kind: "b" });
    expect(heard).toEqual(["a"]);
  });

  it("carries on when one subscriber throws, since the others are innocent", () => {
    const events = log();
    const heard: string[] = [];
    events.subscribe("office-1", () => {
      throw new Error("this listener is broken");
    });
    events.subscribe("office-1", (event) => heard.push(String(event.data["kind"])));
    expect(() => events.publish("office-1", { kind: "a" })).not.toThrow();
    expect(heard).toEqual(["a"]);
  });

  it("keeps a bounded history, dropping the oldest first", () => {
    const events = new OfficeEventLog({ now: () => 0, historyLimit: 3 });
    for (const kind of ["a", "b", "c", "d", "e"]) events.publish("office-1", { kind });
    const kept = events.since("office-1", 0);
    expect(kept.map((e) => e.data["kind"])).toEqual(["c", "d", "e"]);
    // Offsets keep counting, so a client can still tell what it missed.
    expect(kept.at(-1)?.offset).toBe(5);
  });

  it("says plainly when a client has fallen too far behind to be caught up", () => {
    const events = new OfficeEventLog({ now: () => 0, historyLimit: 2 });
    for (const kind of ["a", "b", "c", "d"]) events.publish("office-1", { kind });
    expect(events.canReplayFrom("office-1", 2)).toBe(true);
    expect(events.canReplayFrom("office-1", 1)).toBe(false);
  });
});

describe("has this changed under me", () => {
  it("says so when the entity changed after the offset a client holds", () => {
    const events = log();
    events.publish("office-1", { kind: "department.updated", id: "d1" });
    expect(events.changedSince("office-1", "d1", 0)).toBe(true);
  });

  it("says no when the only change is the one the client already has", () => {
    const events = log();
    events.publish("office-1", { kind: "department.updated", id: "d1" });
    expect(events.changedSince("office-1", "d1", 1)).toBe(false);
  });

  it("does not confuse one entity's changes with another's", () => {
    const events = log();
    events.publish("office-1", { kind: "department.updated", id: "d1" });
    events.publish("office-1", { kind: "department.updated", id: "d2" });
    expect(events.changedSince("office-1", "d1", 1)).toBe(false);
    expect(events.changedSince("office-1", "d2", 1)).toBe(true);
  });

  it("does not confuse one office with another", () => {
    const events = log();
    events.publish("office-2", { kind: "department.updated", id: "d1" });
    expect(events.changedSince("office-1", "d1", 0)).toBe(false);
  });

  it("assumes the worst when the history no longer reaches back that far", () => {
    const events = new OfficeEventLog({ now: () => 0, historyLimit: 2 });
    for (const kind of ["a", "b", "c"]) events.publish("office-1", { kind, id: "other" });
    // The client's offset is older than anything kept, so nobody can say.
    expect(events.changedSince("office-1", "d1", 0)).toBe(true);
  });
});
