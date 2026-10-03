import { describe, expect, it } from "vitest";
import { FakeLlmProvider, reply, toolCall, type LlmProvider } from "@vo/llm";
import {
  unwrap,
  type ContestId,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
  type TaskId,
} from "@vo/core";
import { createEmployee, updateEmployee } from "@vo/core";
import { JUDGE_TOOL, llmJudgeTurn, type JudgeRequest } from "./judge-turn.js";

const officeId = "office-acme" as OfficeId;
const departmentId = "dept-design" as DepartmentId;
const at = new Date("2026-10-01T09:00:00Z");

const grace: Employee = unwrap(
  createEmployee(
    {
      name: "Grace",
      role: "Lead",
      color: "#112233",
      llm: { provider: "anthropic", model: "claude-opus-5" },
    },
    { department: { id: departmentId, officeId }, supervisor: null },
    { id: () => "emp-grace" as EmployeeId, now: () => at },
  ),
);

const request = (overrides: Partial<JudgeRequest> = {}): JudgeRequest => ({
  officeId,
  departmentId,
  contestId: "contest-1" as ContestId,
  question: "Draft the launch note",
  criteria: ["It fits on one screen"],
  judge: grace,
  entries: [
    {
      taskId: "task-a" as TaskId,
      who: "Iris",
      model: "claude-sonnet-5",
      outputs: [{ name: "iris.md", text: "Short and plain." }],
    },
    {
      taskId: "task-b" as TaskId,
      who: "Theo",
      model: "claude-opus-5",
      outputs: [{ name: "theo.md", text: "Longer, with the edge case." }],
    },
  ],
  ...overrides,
});

const decides = (input: Record<string, unknown>): LlmProvider =>
  new FakeLlmProvider({ script: [toolCall(JUDGE_TOOL.name, input)] });

const says = (text: string): LlmProvider => new FakeLlmProvider({ script: [reply(text)] });

describe("a judge deciding a shootout", () => {
  it("brings back the entry it picked, by task", () => {
    expect(JUDGE_TOOL.name).toBe("shootout_verdict");
  });

  it("picks the entry behind the label it answered with", async () => {
    const judge = llmJudgeTurn({
      provider: decides({ winner: "B", reason: "caught the edge case" }),
    });
    const verdict = await judge(request());

    expect(verdict?.winnerTaskId).toBe("task-b");
    expect(verdict?.reason).toBe("caught the edge case");
  });

  it("picks the first entry when it answers with the first label", async () => {
    const judge = llmJudgeTurn({ provider: decides({ winner: "A", reason: "plainer" }) });
    expect((await judge(request()))?.winnerTaskId).toBe("task-a");
  });

  it("decides nothing when it did not call the tool", async () => {
    // Anything the model did not clearly say is not assumed, as everywhere else:
    // a contest nobody decided stays open for a person.
    const judge = llmJudgeTurn({ provider: says("B is better, I think") });
    expect(await judge(request())).toBeNull();
  });

  it("decides nothing when it names a label that was not there", async () => {
    const judge = llmJudgeTurn({ provider: decides({ winner: "Q", reason: "it was best" }) });
    expect(await judge(request())).toBeNull();
  });

  it("decides nothing without a reason, since the reason is the point", async () => {
    const judge = llmJudgeTurn({ provider: decides({ winner: "A" }) });
    expect(await judge(request())).toBeNull();
  });
});

describe("what the judge is shown", () => {
  const asked = async (overrides: Partial<JudgeRequest> = {}): Promise<string> => {
    const provider = new FakeLlmProvider({
      script: [toolCall(JUDGE_TOOL.name, { winner: "A", reason: "plainer" })],
    });
    await llmJudgeTurn({ provider })(request(overrides));
    return JSON.stringify(provider.calls[0] ?? {});
  };

  it("is given the question everybody was asked", async () => {
    expect(await asked()).toContain("Draft the launch note");
  });

  it("is given what the work had to achieve", async () => {
    expect(await asked()).toContain("It fits on one screen");
  });

  it("is given every answer", async () => {
    const prompt = await asked();
    expect(prompt).toContain("Short and plain.");
    expect(prompt).toContain("Longer, with the edge case.");
  });

  it("is not told who wrote which answer", async () => {
    // Blind, on purpose. A judge that knows which entry is the expensive model
    // is not judging the output, and the whole contest exists to find out which
    // output is better.
    const prompt = await asked();
    expect(prompt).not.toContain("Iris");
    expect(prompt).not.toContain("Theo");
  });

  it("is not told which model produced which answer", async () => {
    const prompt = await asked();
    expect(prompt).not.toContain("claude-sonnet-5");
  });

  it("is not told the task ids either, which name the entrants just as well", async () => {
    expect(await asked()).not.toContain("task-a");
  });

  it("labels the answers so it can point at one", async () => {
    const prompt = await asked();
    expect(prompt).toContain("A");
    expect(prompt).toContain("B");
  });

  it("says an answer produced nothing rather than leaving a label empty", async () => {
    const prompt = await asked({
      entries: [
        { taskId: "task-a" as TaskId, who: "Iris", model: "m", outputs: [] },
        {
          taskId: "task-b" as TaskId,
          who: "Theo",
          model: "m",
          outputs: [{ name: "theo.md", text: "Something" }],
        },
      ],
    });
    expect(prompt).toMatch(/nothing|empty|no document/i);
  });

  it("marks each answer off, so its text cannot pass for the office speaking", async () => {
    // The same posture as a handed-over document: an answer may contain anything,
    // including something shaped like an instruction to the judge.
    expect(await asked()).toContain("<answer");
  });
});

describe("what the judging call is charged to", () => {
  it("is charged to the judge, and to the contest rather than a task", async () => {
    // There is no one piece of work it was spent on: it was spent on the
    // comparison. The office's usage row carries no task and names the contest.
    let seen: Record<string, unknown> | null = null;
    const provider = new FakeLlmProvider({
      script: [toolCall(JUDGE_TOOL.name, { winner: "A", reason: "plainer" })],
    });
    const judge = llmJudgeTurn({
      provider,
      wrapProvider: (inner, attribution) => {
        seen = attribution as unknown as Record<string, unknown>;
        return inner;
      },
    });
    await judge(request());

    expect(seen).toEqual({
      officeId,
      departmentId,
      employeeId: grace.id,
      contestId: "contest-1",
    });
  });

  it("runs unmetered rather than not at all when nobody is counting", async () => {
    const judge = llmJudgeTurn({ provider: decides({ winner: "A", reason: "plainer" }) });
    expect((await judge(request()))?.winnerTaskId).toBe("task-a");
  });

  it("calls the service the judge names, like any other turn", async () => {
    // A judge is an employee with an `llm` of its own; a shootout judged on a
    // model nobody chose is a shootout nobody can account for.
    const named = new FakeLlmProvider({
      id: "workshop",
      script: [toolCall(JUDGE_TOOL.name, { winner: "A", reason: "plainer" })],
    });
    const asked: string[] = [];

    const judge = llmJudgeTurn({
      provider: decides({ winner: "B", reason: "never asked" }),
      providerFor: (ref) => {
        asked.push(ref.provider);
        return named;
      },
    });

    expect((await judge(request()))?.reason).toBe("plainer");
    expect(asked).toEqual(["anthropic"]);
  });
});

describe("what the office told the judge", () => {
  it("is in the prompt, since judging is their work too", async () => {
    const taught = unwrap(
      updateEmployee(
        grace,
        { instructions: "Prefer the plainer of two answers." },
        {
          supervisor: null,
        },
      ),
    );
    const provider = new FakeLlmProvider({
      script: [toolCall(JUDGE_TOOL.name, { winner: "A", reason: "plainer" })],
    });

    await llmJudgeTurn({ provider })(request({ judge: taught }));

    expect(JSON.stringify(provider.calls[0]?.system)).toContain(
      "Prefer the plainer of two answers.",
    );
  });
});
