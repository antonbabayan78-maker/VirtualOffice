import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  createDepartment,
  createDocument,
  createEmployee,
  createTask,
  unwrap,
  type Bench,
  type BenchId,
  type Department,
  type DepartmentId,
  type Document,
  type DocumentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
  type Task,
  type TaskId,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { BenchRecord } from "./BenchRecord.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-30T09:00:00Z");

const design: Department = unwrap(
  createDepartment({ officeId, name: "Design", color: "#7c5cff", position: { x: 0, y: 0 } }, [], {
    id: () => "dept-design" as DepartmentId,
    now: () => at,
  }),
);

const person = (id: string, name: string, model: string): Employee =>
  unwrap(
    createEmployee(
      { name, role: "Designer", color: "#00aa66", llm: { provider: "anthropic", model } },
      { department: { id: design.id, officeId }, supervisor: null },
      { id: () => id as EmployeeId, now: () => at },
    ),
  );

const iris = person("emp-iris", "Iris", "claude-sonnet-5");
const theo = person("emp-theo", "Theo", "claude-opus-5");

const benchId = "bench-draft" as BenchId;
const bench: Bench = {
  id: benchId,
  name: "Drafting",
  memberIds: [iris.id, theo.id],
  strategy: "round_robin",
};

let made = 0;
const work = (title: string, assigneeId: EmployeeId, placedBy: BenchId | null = benchId): Task => ({
  ...unwrap(
    createTask(
      { officeId, departmentId: design.id, title, assigneeId },
      {
        id: () => `task-${String(++made)}` as TaskId,
        now: () => at,
      },
    ),
  ),
  benchId: placedBy,
});

const output = (id: string, taskId: string, name: string): Document =>
  unwrap(
    createDocument(
      {
        officeId,
        owner: { kind: "task", id: taskId },
        tray: "out",
        name,
        mediaType: "text/markdown",
        size: 2048,
      },
      { id: () => id as DocumentId, now: () => at },
    ),
  );

let store: OfficeStore;

function open(tasks: readonly Task[] = [], documents: readonly Document[] = []) {
  cleanup();
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().load([design], [iris, theo], tasks, []);
  store.getState().loadDocuments(documents);
  return render(<BenchRecord store={store} bench={bench} />);
}

const panel = () => screen.getByRole("group", { name: /what drafting handed out/i });

beforeEach(() => {
  made = 0;
});

describe("what a bench has handed out", () => {
  it("says it has handed out nothing yet, rather than showing an empty table", () => {
    open();
    expect(panel()).toHaveTextContent(/nothing yet|not handed/i);
  });

  it("lists the work it placed", () => {
    open([work("Draw the export screen", iris.id)]);
    expect(panel()).toHaveTextContent("Draw the export screen");
  });

  it("says who each piece went to", () => {
    open([work("Draw the export screen", iris.id)]);
    expect(panel()).toHaveTextContent("Iris");
  });

  it("says which model they are on, which is the whole point", () => {
    // Comparing two people is only interesting when you can see what they are
    // running; without this the record answers "who" and not "which model".
    open([work("One", iris.id), work("Two", theo.id)]);
    expect(panel()).toHaveTextContent("claude-sonnet-5");
    expect(panel()).toHaveTextContent("claude-opus-5");
  });

  it("does not list work the bench did not place", () => {
    open([work("Mine", iris.id), work("Somebody else's", theo.id, null)]);

    expect(panel()).toHaveTextContent("Mine");
    expect(panel()).not.toHaveTextContent("Somebody else's");
  });

  it("does not list work another bench placed", () => {
    open([work("Mine", iris.id), work("Theirs", theo.id, "bench-other" as BenchId)]);
    expect(panel()).not.toHaveTextContent("Theirs");
  });

  it("shows what came out of each piece of work", () => {
    const task = work("Draw the export screen", iris.id);
    open([task], [output("doc-1", task.id, "export-screen.md")]);

    expect(panel()).toHaveTextContent("export-screen.md");
  });

  it("says when a piece of work has produced nothing yet", () => {
    // An empty cell reads as a bug; "nothing yet" reads as work in progress.
    open([work("Draw the export screen", iris.id)]);
    expect(panel()).toHaveTextContent(/nothing yet/i);
  });

  it("keeps each piece of work's output with that piece of work", () => {
    const mine = work("Mine", iris.id);
    const theirs = work("Theirs", theo.id);
    open(
      [mine, theirs],
      [output("doc-1", mine.id, "mine.md"), output("doc-2", theirs.id, "theirs.md")],
    );

    const rows = within(panel()).getAllByRole("listitem");
    const forMine = rows.find((row) => row.textContent.includes("Mine"));
    expect(forMine).toHaveTextContent("mine.md");
    expect(forMine).not.toHaveTextContent("theirs.md");
  });

  it("counts what each member has taken, so the split is visible", () => {
    open([work("One", iris.id), work("Two", theo.id), work("Three", iris.id)]);
    expect(panel()).toHaveTextContent(/Iris.*2|2.*Iris/s);
  });

  it("names a member who has left the office rather than showing a bare id", () => {
    open([work("One", "emp-gone" as EmployeeId)]);
    expect(panel()).not.toHaveTextContent("emp-gone");
  });
});
