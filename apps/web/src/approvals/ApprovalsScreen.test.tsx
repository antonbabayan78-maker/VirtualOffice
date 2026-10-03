import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDepartment,
  createEmployee,
  unwrap,
  type Department,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
} from "@vo/core";
import type { Waiting } from "@vo/api-client";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { ApprovalsScreen } from "./ApprovalsScreen.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-10-03T09:00:00Z");

const post: Department = unwrap(
  createDepartment(
    { officeId, name: "Post room", color: "#7c5cff", position: { x: 0, y: 0 } },
    [],
    {
      id: () => "dept-post" as DepartmentId,
      now: () => at,
    },
  ),
);

const ada: Employee = unwrap(
  createEmployee(
    {
      name: "Ada",
      role: "Clerk",
      color: "#00aa66",
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
    },
    { department: { id: post.id, officeId }, supervisor: null },
    { id: () => "emp-ada" as EmployeeId, now: () => at },
  ),
);

const call = (overrides: Partial<Extract<Waiting, { kind: "call" }>> = {}): Waiting => ({
  kind: "call",
  taskId: "task-1",
  title: "Tell the customer their order shipped",
  departmentId: post.id,
  assigneeId: ada.id,
  since: at,
  key: "toolu_1",
  name: "post__send_email",
  input: { to: "customer@acme.test", body: "it is on its way" },
  gates: ["external_send"],
  detail: 'tool "post__send_email" (external_send)',
  ...overrides,
});

const review = (overrides: Partial<Extract<Waiting, { kind: "review" }>> = {}): Waiting => ({
  kind: "review",
  taskId: "task-2",
  title: "Ship release 4.2",
  departmentId: post.id,
  assigneeId: ada.id,
  since: at,
  gates: ["deploy"],
  ...overrides,
});

const stopped = (overrides: Partial<Extract<Waiting, { kind: "stopped" }>> = {}): Waiting => ({
  kind: "stopped",
  taskId: "task-3",
  title: "Write up the postmortem",
  departmentId: post.id,
  assigneeId: ada.id,
  since: at,
  status: "blocked",
  reason: "waiting on the customer's address",
  ...overrides,
});

let store: OfficeStore;
let posted: { taskId: string; event: Record<string, unknown> }[];

/** The screen over a store that holds an office and answers what it is told. */
function open(waiting: readonly Waiting[], answer?: unknown) {
  cleanup();
  posted = [];
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().load([post], [ada]);
  store.getState().loadWaiting(waiting);
  store.getState().connect({
    postTaskEvent: (taskId: string, event: Record<string, unknown>) => {
      posted.push({ taskId, event });
      return Promise.resolve(answer ?? { ok: true, value: { id: taskId, status: "in_progress" } });
    },
  } as never);
  return render(<ApprovalsScreen store={store} />);
}

const inbox = () => screen.getByRole("region", { name: /approvals/i });
const rows = () => within(inbox()).getAllByRole("group");
const row = (name: RegExp) => within(inbox()).getByRole("group", { name });

beforeEach(() => {
  open([]);
});

describe("an inbox with nothing in it", () => {
  it("says so, rather than showing an empty list", () => {
    expect(inbox()).toHaveTextContent(/nothing is waiting/i);
  });

  it("shows no rows at all", () => {
    expect(within(inbox()).queryAllByRole("group")).toEqual([]);
  });
});

describe("a call a run may not make", () => {
  it("says who, where, and what they want to call", () => {
    open([call()]);

    const one = row(/send_email/i);
    expect(one).toHaveTextContent("Ada");
    expect(one).toHaveTextContent("Post room");
    expect(one).toHaveTextContent("post__send_email");
    expect(one).toHaveTextContent("Tell the customer their order shipped");
  });

  it("shows the arguments, which are the thing being decided", () => {
    // Without them this screen could only offer "may this task send email",
    // which is approving the tool in advance.
    open([call()]);

    expect(row(/send_email/i)).toHaveTextContent("customer@acme.test");
    expect(row(/send_email/i)).toHaveTextContent("it is on its way");
  });

  it("says what kind of thing it is, in the office's own words", () => {
    open([call()]);
    expect(row(/send_email/i)).toHaveTextContent("external_send");
  });

  it("allows it, naming the one call rather than the tool", async () => {
    open([call()]);
    const user = userEvent.setup();

    await user.click(within(row(/send_email/i)).getByRole("button", { name: /^allow$/i }));

    expect(posted).toEqual([
      {
        taskId: "task-1",
        event: { type: "call_decided", key: "toolu_1", decision: "approved" },
      },
    ]);
  });

  it("refuses it with a reason, which the run is told", async () => {
    open([call()]);
    const user = userEvent.setup();

    await user.click(within(row(/send_email/i)).getByRole("button", { name: /refuse/i }));
    await user.type(within(row(/send_email/i)).getByLabelText(/why not/i), "not that address");
    await user.click(within(row(/send_email/i)).getByRole("button", { name: /refuse this call/i }));

    expect(posted[0]?.event).toMatchObject({
      type: "call_decided",
      decision: "declined",
      reason: "not that address",
    });
  });

  it("refuses it without one, since a refusal is not a cancellation", async () => {
    open([call()]);
    const user = userEvent.setup();

    await user.click(within(row(/send_email/i)).getByRole("button", { name: /refuse/i }));
    await user.click(within(row(/send_email/i)).getByRole("button", { name: /refuse this call/i }));

    expect(posted[0]?.event).toMatchObject({ decision: "declined" });
  });

  it("says plainly that the work goes on without it", async () => {
    open([call()]);
    const user = userEvent.setup();

    await user.click(within(row(/send_email/i)).getByRole("button", { name: /refuse/i }));

    expect(row(/send_email/i)).toHaveTextContent(/carries on|without it/i);
  });

  it("takes it off the list once it is answered", async () => {
    open([call()]);
    const user = userEvent.setup();

    await user.click(within(row(/send_email/i)).getByRole("button", { name: /^allow$/i }));

    expect(inbox()).toHaveTextContent(/nothing is waiting/i);
  });

  it("answers one call of several on its own", async () => {
    open([call(), call({ key: "toolu_2", name: "post__delete_all", input: {} })]);
    const user = userEvent.setup();

    await user.click(within(row(/send_email/i)).getByRole("button", { name: /^allow$/i }));

    expect(rows()).toHaveLength(1);
    expect(inbox()).toHaveTextContent("post__delete_all");
  });
});

describe("finished work a department holds", () => {
  it("says what it involved, which is why it is being held", () => {
    open([review()]);

    const one = row(/ship release 4\.2/i);
    expect(one).toHaveTextContent("deploy");
    expect(one).toHaveTextContent("Ada");
  });

  it("approves it", async () => {
    open([review()]);
    const user = userEvent.setup();

    await user.click(within(row(/ship release/i)).getByRole("button", { name: /^approve$/i }));

    expect(posted).toEqual([
      { taskId: "task-2", event: { type: "gate_decided", decision: "approved" } },
    ]);
  });

  it("sends it back with a reason, which the office insists on", async () => {
    open([review()]);
    const user = userEvent.setup();

    await user.click(within(row(/ship release/i)).getByRole("button", { name: /send it back/i }));
    const sendBack = within(row(/ship release/i)).getByRole("button", {
      name: /^send it back$/i,
    });
    expect(sendBack).toBeDisabled();

    await user.type(within(row(/ship release/i)).getByLabelText(/why/i), "not on a Friday");
    await user.click(sendBack);

    expect(posted[0]?.event).toMatchObject({
      type: "gate_decided",
      decision: "rejected",
      reason: "not on a Friday",
    });
  });
});

describe("work that simply stopped", () => {
  it("says why, and does not pretend it is a decision", () => {
    open([stopped()]);

    const one = row(/postmortem/i);
    expect(one).toHaveTextContent("waiting on the customer's address");
    expect(within(one).queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("puts it back to work, which is the one thing to do with it from here", async () => {
    open([stopped()]);
    const user = userEvent.setup();

    await user.click(within(row(/postmortem/i)).getByRole("button", { name: /back to work/i }));

    expect(posted).toEqual([{ taskId: "task-3", event: { type: "unblock" } }]);
  });

  it("says when it was escalated rather than blocked", () => {
    open([stopped({ status: "escalated", reason: "nobody could finish it" })]);

    expect(row(/postmortem/i)).toHaveTextContent(/escalated/i);
  });
});

describe("when the office refuses the decision", () => {
  it("says what it said, rather than appearing to work", async () => {
    open([call()], {
      ok: false,
      kind: "validation",
      errors: [{ path: "status", message: "that work is not waiting any more" }],
    });
    const user = userEvent.setup();

    await user.click(within(row(/send_email/i)).getByRole("button", { name: /^allow$/i }));

    expect(await within(inbox()).findByRole("alert")).toHaveTextContent(/not waiting any more/i);
    expect(rows()).toHaveLength(1);
  });
});

describe("reading the list", () => {
  it("keeps the office's order, which is oldest first", () => {
    open([stopped(), call(), review()]);

    expect(rows().map((one) => one.getAttribute("aria-label"))).toEqual([
      expect.stringContaining("postmortem"),
      expect.stringContaining("send_email"),
      expect.stringContaining("Ship release"),
    ]);
  });

  it("says how long each one has been waiting", () => {
    open([call()]);

    expect(row(/send_email/i)).toHaveTextContent("2026-10-03");
  });

  it("names an employee the canvas does not know by their id, rather than nobody", () => {
    open([call({ assigneeId: "emp-gone" })]);

    expect(row(/send_email/i)).toHaveTextContent("emp-gone");
  });

  it("says nobody when the work is assigned to nobody", () => {
    open([call({ assigneeId: null })]);

    expect(row(/send_email/i)).toHaveTextContent(/nobody/i);
  });
});
