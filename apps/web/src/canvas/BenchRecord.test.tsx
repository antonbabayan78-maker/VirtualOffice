import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  judgeId: null,
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

describe("what each member's work cost", () => {
  const spend = (
    id: string,
    taskId: string,
    employeeId: EmployeeId,
    totalUsd: number | null,
    durationMs = 1200,
  ) =>
    ({
      id,
      officeId,
      taskId,
      employeeId,
      at,
      event: {
        kind: "llm_call",
        model: "claude-sonnet-5",
        durationMs,
        cost: totalUsd === null ? null : { totalUsd },
      },
    }) as never;

  const openWithSpend = (tasks: readonly Task[], usage: readonly unknown[]) => {
    cleanup();
    store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    store.getState().load([design], [iris, theo], tasks, []);
    store.getState().loadUsage(usage as never);
    return render(<BenchRecord store={store} bench={bench} />);
  };

  it("adds up what each member has spent", () => {
    const mine = work("One", iris.id);
    const theirs = work("Two", theo.id);
    openWithSpend(
      [mine, theirs],
      [
        spend("u1", mine.id, iris.id, 0.01),
        spend("u2", mine.id, iris.id, 0.02),
        spend("u3", theirs.id, theo.id, 0.04),
      ],
    );

    expect(panel()).toHaveTextContent("$0.03");
    expect(panel()).toHaveTextContent("$0.04");
  });

  it("shows what one piece of work cost, beside what it produced", () => {
    const mine = work("One", iris.id);
    openWithSpend([mine], [spend("u1", mine.id, iris.id, 0.01)]);

    const row = within(panel())
      .getAllByRole("listitem")
      .find((one) => one.textContent.includes("One"));
    expect(row).toHaveTextContent("$0.01");
  });

  it("shows how long the work took", () => {
    const mine = work("One", iris.id);
    openWithSpend([mine], [spend("u1", mine.id, iris.id, 0.01, 2500)]);
    expect(panel()).toHaveTextContent(/2\.5\s*s/);
  });

  it("says a piece of work has cost nothing yet rather than showing zero", () => {
    // Nothing spent and nothing recorded look the same as $0.00, and one of
    // them means the pipeline is broken.
    openWithSpend([work("One", iris.id)], []);
    expect(panel()).toHaveTextContent(/not recorded|nothing recorded/i);
  });

  it("does not count another bench's spend", () => {
    const mine = work("One", iris.id);
    const elsewhere = work("Theirs", theo.id, "bench-other" as BenchId);
    openWithSpend(
      [mine, elsewhere],
      [spend("u1", mine.id, iris.id, 0.01), spend("u2", elsewhere.id, theo.id, 9.99)],
    );

    expect(panel()).not.toHaveTextContent("9.99");
  });

  it("leaves out a member's spend on work this bench did not place", () => {
    // Iris is on the bench and also has a task somebody assigned her directly.
    // Her figure here is what the bench cost, not what she cost.
    const onBench = work("Through the bench", iris.id);
    const direct = work("Given to her directly", iris.id, null);
    openWithSpend(
      [onBench, direct],
      [spend("u1", onBench.id, iris.id, 0.01), spend("u2", direct.id, iris.id, 7.5)],
    );

    expect(panel()).toHaveTextContent("$0.01");
    expect(panel()).not.toHaveTextContent("7.5");
  });

  it("shows a few tenths of a cent without rounding them to nothing", () => {
    // Two decimals would render $0.008 as "$0.01", which overstates it, and a
    // cheap model's whole point is that it is cheap.
    const mine = work("One", iris.id);
    openWithSpend([mine], [spend("u1", mine.id, iris.id, 0.008)]);
    expect(panel()).toHaveTextContent("$0.008");
  });

  it("does not pad a small figure with zeros it does not have", () => {
    const mine = work("One", iris.id);
    openWithSpend([mine], [spend("u1", mine.id, iris.id, 0.008)]);
    expect(panel()).not.toHaveTextContent("$0.0080");
  });

  it("shows a total containing an unpriced call as a floor, not a number", () => {
    // cost is null when the registry has no price for a model, deliberately,
    // so that nothing can quietly add it to a total and call it free.
    const mine = work("One", iris.id);
    openWithSpend(
      [mine],
      [spend("u1", mine.id, iris.id, 0.01), spend("u2", mine.id, iris.id, null)],
    );

    expect(panel()).toHaveTextContent(/at least/i);
  });

  it("names how many calls went unpriced, so the gap can be closed", () => {
    const mine = work("One", iris.id);
    openWithSpend([mine], [spend("u1", mine.id, iris.id, null)]);
    expect(panel()).toHaveTextContent(/1 call|unpriced/i);
  });
});

describe("a shootout: everybody's answer to the same question", () => {
  const shootout: Bench = { ...bench, strategy: "shootout" };

  /** One contest: the same job, one entry per person, in whatever state. */
  const contest = (
    contestId: string,
    entries: readonly { readonly who: Employee; readonly status?: string }[],
    title = "Draft the launch note",
    ran = at,
  ): readonly Task[] =>
    entries.map(
      (entry) =>
        ({
          ...work(title, entry.who.id),
          contestId,
          status: entry.status ?? "done",
          createdAt: ran,
        }) as Task,
    );

  function openContest(tasks: readonly Task[], documents: readonly Document[] = []) {
    cleanup();
    store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    store.getState().load([design], [iris, theo], tasks, []);
    store.getState().loadDocuments(documents);
    return render(<BenchRecord store={store} bench={shootout} />);
  }

  const theContest = () => within(panel()).getByRole("group", { name: /draft the launch note/i });

  it("states the question once, rather than once per entry", () => {
    openContest(contest("contest-1", [{ who: iris }, { who: theo }]));
    expect(within(panel()).getAllByText("Draft the launch note")).toHaveLength(1);
  });

  it("shows each person's answer with the model they ran", () => {
    openContest(contest("contest-1", [{ who: iris }, { who: theo }]));
    expect(theContest()).toHaveTextContent("Iris");
    expect(theContest()).toHaveTextContent("claude-sonnet-5");
    expect(theContest()).toHaveTextContent("Theo");
    expect(theContest()).toHaveTextContent("claude-opus-5");
  });

  it("shows what each of them produced", () => {
    const entries = contest("contest-1", [{ who: iris }, { who: theo }]);
    openContest(entries, [
      output("doc-1", entries[0]?.id ?? "", "iris-draft.md"),
      output("doc-2", entries[1]?.id ?? "", "theo-draft.md"),
    ]);

    expect(theContest()).toHaveTextContent("iris-draft.md");
    expect(theContest()).toHaveTextContent("theo-draft.md");
  });

  it("says it is still going while an answer is missing", () => {
    openContest(contest("contest-1", [{ who: iris }, { who: theo, status: "in_progress" }]));
    expect(theContest()).toHaveTextContent(/still|waiting|not in yet/i);
  });

  it("does not ask for a verdict before the answers are in", () => {
    // Picking a winner against work nobody has finished is a coin toss.
    openContest(contest("contest-1", [{ who: iris }, { who: theo, status: "in_progress" }]));
    expect(within(theContest()).queryByRole("button", { name: /record verdict/i })).toBeNull();
  });

  it("asks which one won once they are all in", () => {
    openContest(contest("contest-1", [{ who: iris }, { who: theo }]));
    expect(within(theContest()).getByRole("button", { name: /record verdict/i })).toBeTruthy();
  });

  it("will not record a verdict with no reason", () => {
    // A winner with no reason is a preference, and the reason is the only part
    // anybody can act on later.
    openContest(contest("contest-1", [{ who: iris }, { who: theo }]));
    expect(within(theContest()).getByRole("button", { name: /record verdict/i })).toBeDisabled();
  });

  it("records the winner, with the reason", async () => {
    const entries = contest("contest-1", [{ who: iris }, { who: theo }]);
    openContest(entries);
    const user = userEvent.setup();

    await user.selectOptions(within(theContest()).getByLabelText(/winner/i), entries[1]?.id ?? "");
    await user.type(within(theContest()).getByLabelText(/why/i), "tighter, and it kept the detail");
    await user.click(within(theContest()).getByRole("button", { name: /record verdict/i }));

    const winner = store.getState().tasks.find((task) => task.id === entries[1]?.id);
    expect(winner?.won?.reason).toBe("tighter, and it kept the detail");
  });

  it("shows the verdict once it has one, and asks for no other", async () => {
    const entries = contest("contest-1", [{ who: iris }, { who: theo }]);
    openContest(entries);
    const user = userEvent.setup();
    await user.type(within(theContest()).getByLabelText(/why/i), "clearer");
    await user.click(within(theContest()).getByRole("button", { name: /record verdict/i }));

    expect(theContest()).toHaveTextContent(/won/i);
    expect(theContest()).toHaveTextContent("clearer");
    expect(within(theContest()).queryByRole("button", { name: /record verdict/i })).toBeNull();
  });

  it("says a person decided it", () => {
    const decided = contest("contest-1", [{ who: iris }, { who: theo }]).map((entry, index) =>
      index === 0
        ? { ...entry, won: { reason: "clearer", decidedBy: null, decidedAt: at } }
        : entry,
    );
    openContest(decided);

    expect(theContest()).toHaveTextContent(/a person|you decided|by hand/i);
  });

  it("names the employee that decided it", () => {
    const decided = contest("contest-1", [{ who: iris }, { who: theo }]).map((entry, index) =>
      index === 0
        ? { ...entry, won: { reason: "clearer", decidedBy: theo.id, decidedAt: at } }
        : entry,
    );
    openContest(decided);

    expect(theContest()).toHaveTextContent(/Theo/);
  });

  it("reads an answer out, because comparing file names tells nobody anything", async () => {
    const entries = contest("contest-1", [{ who: iris }, { who: theo }]);
    openContest(entries, [output("doc-1", entries[0]?.id ?? "", "iris-draft.md")]);
    store.setState({
      fetchBody: () => Promise.resolve(new TextEncoder().encode("# Iris says\nkeep it short")),
    });

    await userEvent
      .setup()
      .click(within(theContest()).getByRole("button", { name: /read iris-draft/i }));
    expect(await screen.findByText(/keep it short/)).toBeTruthy();
  });

  it("keeps two contests apart, newest first", () => {
    const older = contest("contest-1", [{ who: iris }], "The older question", at);
    const newer = contest(
      "contest-2",
      [{ who: theo }],
      "The newer question",
      new Date("2026-09-30T15:00:00Z"),
    );
    openContest([...older, ...newer]);

    const blocks = within(panel()).getAllByRole("group");
    expect(blocks[0]).toHaveTextContent("The newer question");
    expect(blocks[1]).toHaveTextContent("The older question");
  });

  it("says nothing has run off yet rather than showing an empty comparison", () => {
    openContest([]);
    expect(panel()).toHaveTextContent(/nothing yet/i);
  });

  it("still lists work in turn when the bench takes work in turn", () => {
    // The flat record is not replaced: it is what a round robin bench is for.
    open([work("Draw the export screen", iris.id)]);
    expect(panel()).toHaveTextContent("Draw the export screen");
    expect(within(panel()).queryByRole("button", { name: /record verdict/i })).toBeNull();
  });
});
