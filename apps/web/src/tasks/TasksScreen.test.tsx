import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDepartment,
  createEmployee,
  unwrap,
  type Department,
  type DepartmentId,
  type Document,
  type Employee,
  type EmployeeId,
  type OfficeId,
  type Task,
  type UsageRecord,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { TasksScreen } from "./TasksScreen.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-10-03T09:00:00Z");
const later = new Date("2026-10-03T11:00:00Z");

const room = (id: string, name: string, overrides: Partial<Department> = {}): Department => ({
  ...unwrap(
    createDepartment({ officeId, name, color: "#7c5cff", position: { x: 0, y: 0 } }, [], {
      id: () => id as DepartmentId,
      now: () => at,
    }),
  ),
  ...overrides,
});

const post = room("dept-post", "Post room", { definitionOfDone: ["somebody read it back"] });
const design = room("dept-design", "Design");

const person = (id: string, name: string, departmentId: DepartmentId): Employee =>
  unwrap(
    createEmployee(
      {
        name,
        role: "Clerk",
        color: "#00aa66",
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      },
      { department: { id: departmentId, officeId }, supervisor: null },
      { id: () => id as EmployeeId, now: () => at },
    ),
  );

const ada = person("emp-ada", "Ada", post.id);
const grace = person("emp-grace", "Grace", post.id);
const iris = person("emp-iris", "Iris", design.id);

const work = (overrides: Record<string, unknown> & { readonly id: string }): Task =>
  ({
    officeId,
    departmentId: post.id,
    title: "Tell the customer",
    brief: "",
    priority: "normal",
    status: "assigned",
    assigneeId: ada.id,
    benchId: null,
    contestId: null,
    won: null,
    reviewerIds: [],
    approvals: [],
    stage: null,
    gatedActions: [],
    dependsOn: [],
    artifacts: [],
    route: [],
    acceptanceCriteria: [],
    checkedBy: [],
    tokenBudget: null,
    deadline: null,
    history: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }) as unknown as Task;

const document = (id: string, taskId: string, name: string): Document =>
  ({
    id,
    officeId,
    ownerKind: "task",
    ownerId: taskId,
    tray: "out",
    name,
    mediaType: "text/markdown",
    size: 120,
    addedBy: ada.id,
    createdAt: at,
  }) as unknown as Document;

const call = (taskId: string, usd: number, tokens = 1000): UsageRecord =>
  ({
    id: `u-${taskId}-${String(usd)}`,
    officeId,
    taskId,
    employeeId: ada.id,
    at,
    event: {
      kind: "llm_call",
      model: "claude-sonnet-5",
      durationMs: 1000,
      usage: { inputTokens: tokens, outputTokens: 200, cacheReadInputTokens: 0 },
      cost: { totalUsd: usd },
    },
  }) as unknown as UsageRecord;

let store: OfficeStore;
let asked: { what: string; body: unknown }[];

function open(
  tasks: readonly Task[],
  extras: {
    readonly documents?: readonly Document[];
    readonly usage?: readonly UsageRecord[];
    readonly answers?: Record<string, unknown>;
  } = {},
) {
  cleanup();
  asked = [];
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => later,
  });
  store.getState().load([post, design], [ada, grace, iris], tasks);
  store.getState().loadDocuments(extras.documents ?? []);
  store.getState().loadUsage(extras.usage ?? []);
  store.getState().connect({
    patchTask: (id: string, changes: Record<string, unknown>) => {
      asked.push({ what: "patch", body: { id, changes } });
      const before = store.getState().tasks.find((one) => one.id === id);
      return Promise.resolve(
        extras.answers?.["patch"] ?? { ok: true, value: { ...before, ...changes } },
      );
    },
    postTaskEvent: (id: string, event: Record<string, unknown>) => {
      asked.push({ what: "event", body: { id, event } });
      const before = store.getState().tasks.find((one) => one.id === id);
      return Promise.resolve(
        extras.answers?.["event"] ?? {
          ok: true,
          value: { ...before, assigneeId: event["toEmployeeId"], status: "assigned" },
        },
      );
    },
  } as never);
  return render(<TasksScreen store={store} />);
}

const board = () => screen.getByRole("region", { name: /tasks/i });
const lane = (name: RegExp) => within(board()).getByRole("group", { name });
const detail = () => screen.getByRole("complementary", { name: /what this work is/i });
const openCard = async (title: RegExp) => {
  const user = userEvent.setup();
  await user.click(within(board()).getByRole("button", { name: title }));
  return user;
};

beforeEach(() => {
  open([]);
});

describe("an office with no work in it", () => {
  it("says so rather than showing empty columns", () => {
    expect(board()).toHaveTextContent(/nothing/i);
  });
});

describe("the lanes work moves along", () => {
  const spread = [
    work({ id: "task-backlog", title: "Draft the note", status: "backlog", assigneeId: null }),
    work({ id: "task-doing", title: "Tell the customer", status: "in_progress" }),
    work({ id: "task-review", title: "Ship 4.2", status: "in_review" }),
    work({ id: "task-done", title: "File the receipts", status: "done" }),
  ];

  it("puts each piece of work in its own lane", () => {
    open(spread);

    expect(lane(/backlog/i)).toHaveTextContent("Draft the note");
    expect(lane(/in progress/i)).toHaveTextContent("Tell the customer");
    expect(lane(/in review/i)).toHaveTextContent("Ship 4.2");
    expect(lane(/done/i)).toHaveTextContent("File the receipts");
  });

  it("says who is holding each piece, and nobody when nobody is", () => {
    open(spread);

    expect(lane(/in progress/i)).toHaveTextContent("Ada");
    expect(lane(/backlog/i)).toHaveTextContent(/nobody/i);
  });

  it("says how many are in each lane, since that is the shape of the day", () => {
    open([
      ...spread,
      work({ id: "task-doing-2", title: "Chase the courier", status: "in_progress" }),
    ]);

    expect(lane(/in progress/i)).toHaveTextContent("2");
  });

  it("marks work that is not at its usual priority", () => {
    open([work({ id: "task-urgent", title: "Fix the invoice", priority: "urgent" })]);

    expect(lane(/assigned/i)).toHaveTextContent(/urgent/i);
  });

  it("keeps work that stopped where it can be seen, rather than in a lane of its own", () => {
    // Blocked and escalated are not stages of anything: they are the stage the
    // work was at, with something wrong, and the approvals inbox is where they
    // are answered.
    open([work({ id: "task-stuck", title: "Tell the customer", status: "blocked" })]);

    expect(lane(/in progress/i)).toHaveTextContent("Tell the customer");
    expect(lane(/in progress/i)).toHaveTextContent(/blocked/i);
  });

  it("does not show cancelled work, which stopped existing", () => {
    open([work({ id: "task-gone", title: "Never mind", status: "cancelled" })]);

    expect(board()).not.toHaveTextContent("Never mind");
  });
});

describe("which room you are looking at", () => {
  const both = [
    work({ id: "task-post", title: "Tell the customer" }),
    work({
      id: "task-design",
      title: "Draw the banner",
      departmentId: design.id,
      assigneeId: iris.id,
    }),
  ];

  it("shows every room until you say otherwise", () => {
    open(both);

    expect(board()).toHaveTextContent("Tell the customer");
    expect(board()).toHaveTextContent("Draw the banner");
  });

  it("shows one room when you pick it", async () => {
    open(both);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/room/i), design.id);

    expect(board()).not.toHaveTextContent("Tell the customer");
    expect(board()).toHaveTextContent("Draw the banner");
  });

  it("offers every room the office has", () => {
    open(both);

    const names = within(screen.getByLabelText(/room/i))
      .getAllByRole("option")
      .map((one) => one.textContent);

    expect(names).toEqual(["All rooms", "Post room", "Design"]);
  });
});

describe("opening a piece of work", () => {
  const history = [
    { at, from: null, to: "assigned", actorId: null, reason: null },
    { at, from: "assigned", to: "in_progress", actorId: ada.id, reason: null },
    {
      at: later,
      from: "in_progress",
      to: "blocked",
      actorId: ada.id,
      reason: "waiting on the address",
    },
  ];
  const one = () =>
    work({
      id: "task-1",
      status: "blocked",
      history,
      artifacts: ["drafted the note"],
      acceptanceCriteria: ["the customer is told the date"],
    });

  it("shows nothing until a piece of work is chosen", () => {
    open([one()]);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("reads its history in the order it happened", async () => {
    open([one()]);
    await openCard(/tell the customer/i);

    const lines = within(detail())
      .getByRole("list", { name: /history/i })
      .querySelectorAll("li");

    expect([...lines].map((line) => line.textContent)).toEqual([
      expect.stringContaining("assigned"),
      expect.stringContaining("in progress"),
      expect.stringContaining("blocked"),
    ]);
  });

  it("says why, where the office recorded one", async () => {
    open([one()]);
    await openCard(/tell the customer/i);

    expect(detail()).toHaveTextContent("waiting on the address");
  });

  it("names who moved it, since a history of ids tells nobody anything", async () => {
    open([one()]);
    await openCard(/tell the customer/i);

    expect(within(detail()).getByRole("list", { name: /history/i })).toHaveTextContent("Ada");
  });

  it("shows what the work produced", async () => {
    open([one()], { documents: [document("doc-1", "task-1", "note.md")] });
    await openCard(/tell the customer/i);

    expect(detail()).toHaveTextContent("note.md");
    expect(detail()).toHaveTextContent("drafted the note");
  });

  it("adds up what it cost, in money and in tokens", async () => {
    open([one()], { usage: [call("task-1", 0.004, 1000), call("task-1", 0.006, 2000)] });
    await openCard(/tell the customer/i);

    expect(detail()).toHaveTextContent("$0.01");
    expect(detail()).toHaveTextContent("3k in");
  });

  it("counts only this piece of work, not the office's whole bill", async () => {
    open([one(), work({ id: "task-2", title: "Something else" })], {
      usage: [call("task-1", 0.004), call("task-2", 9)],
    });
    await openCard(/tell the customer/i);

    expect(detail()).not.toHaveTextContent("$9.00");
  });

  it("says nothing was recorded rather than showing zero", async () => {
    open([one()]);
    await openCard(/tell the customer/i);

    expect(detail()).toHaveTextContent(/not recorded/i);
  });

  it("closes again", async () => {
    open([one()]);
    const user = await openCard(/tell the customer/i);

    await user.click(within(detail()).getByRole("button", { name: /close/i }));

    expect(screen.queryByRole("complementary")).toBeNull();
  });
});

describe("what the work has to achieve", () => {
  const stated = () =>
    work({ id: "task-1", acceptanceCriteria: ["the customer is told the date"] });

  it("shows what this piece of work states", async () => {
    open([stated()]);
    await openCard(/tell the customer/i);

    expect(detail()).toHaveTextContent("the customer is told the date");
  });

  it("names the room's standing list when the work states none of its own", async () => {
    open([work({ id: "task-1" })]);
    await openCard(/tell the customer/i);

    expect(detail()).toHaveTextContent("somebody read it back");
    expect(detail()).toHaveTextContent(/post room/i);
  });

  it("takes another one", async () => {
    open([stated()]);
    const user = await openCard(/tell the customer/i);

    await user.type(within(detail()).getByLabelText(/another/i), "the order number is right");
    await user.click(within(detail()).getByRole("button", { name: /add/i }));

    expect(asked[0]).toEqual({
      what: "patch",
      body: {
        id: "task-1",
        changes: {
          acceptanceCriteria: ["the customer is told the date", "the order number is right"],
        },
      },
    });
  });

  it("takes one away", async () => {
    open([stated()]);
    const user = await openCard(/tell the customer/i);

    await user.click(
      within(detail()).getByRole("button", { name: /remove the customer is told the date/i }),
    );

    expect(asked[0]).toMatchObject({ body: { changes: { acceptanceCriteria: [] } } });
  });

  it("will not add an empty one", async () => {
    open([stated()]);
    await openCard(/tell the customer/i);

    expect(within(detail()).getByRole("button", { name: /add/i })).toBeDisabled();
  });
});

describe("handing work to somebody else", () => {
  it("offers the people this office has, apart from whoever is holding it", async () => {
    open([work({ id: "task-1" })]);
    await openCard(/tell the customer/i);

    const names = within(within(detail()).getByLabelText(/hand it to/i))
      .getAllByRole("option")
      .map((one) => one.textContent);

    expect(names).toContain("Grace");
    expect(names).toContain("Iris");
    expect(names).not.toContain("Ada");
  });

  it("hands it over, and says why", async () => {
    open([work({ id: "task-1" })]);
    const user = await openCard(/tell the customer/i);

    await user.selectOptions(within(detail()).getByLabelText(/hand it to/i), grace.id);
    await user.type(within(detail()).getByLabelText(/why/i), "Ada is away");
    await user.click(within(detail()).getByRole("button", { name: /hand it over/i }));

    expect(asked).toEqual([
      {
        what: "event",
        body: {
          id: "task-1",
          event: { type: "reassign", toEmployeeId: grace.id, reason: "Ada is away" },
        },
      },
    ]);
  });

  it("shows it on the board as the office answered", async () => {
    open([work({ id: "task-1" })]);
    const user = await openCard(/tell the customer/i);

    await user.selectOptions(within(detail()).getByLabelText(/hand it to/i), grace.id);
    await user.click(within(detail()).getByRole("button", { name: /hand it over/i }));

    expect(detail()).toHaveTextContent("Grace");
  });

  it("says what the office said when it refuses", async () => {
    open([work({ id: "task-1" })], {
      answers: {
        event: {
          ok: false,
          kind: "validation",
          errors: [{ path: "status", message: "work that is done cannot be handed on" }],
        },
      },
    });
    const user = await openCard(/tell the customer/i);

    await user.selectOptions(within(detail()).getByLabelText(/hand it to/i), grace.id);
    await user.click(within(detail()).getByRole("button", { name: /hand it over/i }));

    expect(await within(detail()).findByRole("alert")).toHaveTextContent(/cannot be handed on/i);
  });

  it("will not hand finished work anywhere", async () => {
    open([work({ id: "task-1", status: "done" })]);
    await openCard(/tell the customer/i);

    expect(within(detail()).queryByLabelText(/hand it to/i)).toBeNull();
  });
});

describe("work done in somebody else's voice", () => {
  const standingIn = (employee: Employee): Employee => ({
    ...employee,
    understudy: {
      person: "Anna Petrova",
      recordedBy: "owner-1",
      recordedAt: at,
      enabled: true,
      card: "Opens with the first name.",
      cardMadeAt: at,
      cardFromSamples: 3,
      corrections: [],
    },
  });

  const openWithVoice = (
    tasks: readonly Task[],
    documents: readonly Document[] = [],
    answers: Record<string, unknown> = {},
  ) => {
    cleanup();
    asked = [];
    store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => later,
    });
    store.getState().load([post, design], [standingIn(ada), grace, iris], tasks);
    store.getState().loadDocuments(documents);
    store.getState().connect({
      recordCorrection: (id: string, correction: Record<string, unknown>) => {
        asked.push({ what: "correction", body: { id, correction } });
        return Promise.resolve(answers["correction"] ?? { ok: true, value: standingIn(ada) });
      },
      downloadDocument: () =>
        Promise.resolve({
          ok: true,
          value: new TextEncoder().encode("Dear Sir or Madam, your parcel is delayed."),
        }),
    } as never);
    return render(<TasksScreen store={store} />);
  };

  const draft = (): Document =>
    ({
      id: "doc-1" as never,
      officeId,
      ownerKind: "task",
      ownerId: "task-1",
      tray: "out",
      name: "reply.txt",
      mediaType: "text/plain",
      size: 40,
      blobRef: "blob-1",
      addedBy: ada.id,
      addedAt: later,
    }) as unknown as Document;

  it("says whose voice it is in, on the card", () => {
    // An office where you cannot tell is an office nobody can trust.
    openWithVoice([work({ id: "task-1", status: "in_progress", assigneeId: ada.id })]);

    expect(board()).toHaveTextContent(/Anna Petrova/);
  });

  it("says it again where the work is read", async () => {
    openWithVoice([work({ id: "task-1", status: "in_progress", assigneeId: ada.id })]);

    await openCard(/tell the customer/i);

    expect(detail()).toHaveTextContent(/in Anna Petrova's voice/i);
  });

  it("says nothing about a voice for somebody who writes as themselves", async () => {
    open([work({ id: "task-1", status: "in_progress", assigneeId: grace.id })]);

    await openCard(/tell the customer/i);

    expect(detail()).not.toHaveTextContent(/voice/i);
  });

  it("offers the real person a way to say what it should have said", async () => {
    openWithVoice([work({ id: "task-1", status: "in_review", assigneeId: ada.id })], [draft()]);

    const user = await openCard(/tell the customer/i);
    await user.click(within(detail()).getByRole("button", { name: /correct reply.txt/i }));
    const field = within(detail()).getByLabelText("What it should have said");
    await user.clear(field);
    await user.type(field, "Hi Tom, sorted.");
    await user.click(within(detail()).getByRole("button", { name: "Keep the correction" }));

    expect(asked[0]).toMatchObject({
      what: "correction",
      body: {
        id: ada.id,
        correction: {
          // Both halves: what the office wrote, and what the person made it say.
          before: "Dear Sir or Madam, your parcel is delayed.",
          after: "Hi Tom, sorted.",
          taskId: "task-1",
        },
      },
    });
  });

  it("offers nothing to correct on work nobody wrote in a voice", async () => {
    open([work({ id: "task-1", status: "in_review", assigneeId: grace.id })], {
      documents: [draft()],
    });

    await openCard(/tell the customer/i);

    expect(within(detail()).queryByRole("button", { name: /correct/i })).toBeNull();
  });
});
