import { describe, expect, it, vi } from "vitest";
import { FakeLlmProvider, reply, toolCall, type LlmProvider } from "@vo/llm";
import {
  createDepartment,
  createEmployee,
  createTask,
  unwrap,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
  type Task,
  type TaskId,
} from "@vo/core";
import { AGENT_RUN_JOB, AGENT_REVIEW_JOB } from "../schedule/scheduler.js";
import { llmAgentTurn, REVIEW_TOOL, SUBMIT_TOOL } from "./agent-turn.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-28T09:00:00Z");
const eng = unwrap(
  createDepartment(
    { officeId, name: "Engineering", color: "#3366ff", position: { x: 0, y: 0 } },
    [],
    {
      id: () => "dept-eng" as DepartmentId,
      now: () => at,
    },
  ),
);

const person = (name: string, id: string): Employee =>
  unwrap(
    createEmployee(
      {
        name,
        role: "Engineer",
        color: "#00aa66",
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      },
      { department: { id: eng.id, officeId }, supervisor: null },
      { id: () => id as EmployeeId, now: () => at },
    ),
  );
const ada = person("Ada", "emp-ada");
const grace = person("Grace", "emp-grace");

const assigned: Task = unwrap(
  createTask(
    { officeId, departmentId: eng.id, title: "Write the parser", assigneeId: ada.id },
    { id: () => "task-1" as TaskId, now: () => at },
  ),
);
const inReview: Task = { ...assigned, status: "in_review", reviewerIds: [grace.id] };

const turn = (provider: LlmProvider) => llmAgentTurn({ provider });

describe("an employee taking a turn at their own work", () => {
  it("starts the task before doing it, so the office can see work begin", async () => {
    const provider = new FakeLlmProvider({
      script: [toolCall("submit_work", { summary: "parser written" })],
    });
    const events = await turn(provider)({ task: assigned, actor: ada, kind: AGENT_RUN_JOB });

    expect(events[0]).toEqual({ type: "start", actorId: ada.id });
  });

  it("hands the work over when the agent says it is finished", async () => {
    const provider = new FakeLlmProvider({
      script: [toolCall("submit_work", { summary: "parser written" })],
    });
    const events = await turn(provider)({ task: assigned, actor: ada, kind: AGENT_RUN_JOB });

    expect(events[1]).toEqual({
      type: "submit",
      actorId: ada.id,
      artifacts: ["parser written"],
    });
  });

  it("does not start a task that is already under way", async () => {
    const provider = new FakeLlmProvider({
      script: [toolCall("submit_work", { summary: "more done" })],
    });
    const started: Task = { ...assigned, status: "in_progress" };
    const events = await turn(provider)({ task: started, actor: ada, kind: AGENT_RUN_JOB });

    expect(events.map((event) => event.type)).toEqual(["submit"]);
  });

  it("submits nothing when the agent stopped without finishing", async () => {
    // Plain text and no result tool: the run ended, the work did not.
    const provider = new FakeLlmProvider({ script: [reply("I need more information")] });
    const events = await turn(provider)({ task: assigned, actor: ada, kind: AGENT_RUN_JOB });

    expect(events.map((event) => event.type)).toEqual(["start"]);
  });

  it("tells the model who it is and what it is working on", async () => {
    const provider = new FakeLlmProvider({
      script: [toolCall("submit_work", { summary: "done" })],
    });
    await turn(provider)({ task: assigned, actor: ada, kind: AGENT_RUN_JOB });

    const request = provider.calls[0];
    const system = JSON.stringify(request?.system);
    expect(system).toContain("Ada");
    expect(system).toContain("Write the parser");
  });
});

describe("an employee reviewing somebody else's work", () => {
  it("approves when the reviewer is satisfied", async () => {
    const provider = new FakeLlmProvider({
      script: [toolCall("review_verdict", { approved: true })],
    });
    const events = await turn(provider)({ task: inReview, actor: grace, kind: AGENT_REVIEW_JOB });

    expect(events).toEqual([{ type: "approve", actorId: grace.id }]);
  });

  it("sends the work back with the reason the reviewer gave", async () => {
    const provider = new FakeLlmProvider({
      script: [
        toolCall("review_verdict", { approved: false, reason: "no tests for the error path" }),
      ],
    });
    const events = await turn(provider)({ task: inReview, actor: grace, kind: AGENT_REVIEW_JOB });

    expect(events).toEqual([
      { type: "request_changes", actorId: grace.id, reason: "no tests for the error path" },
    ]);
  });

  it("treats a verdict that is not an approval as changes requested, not as approval", async () => {
    // A model that answers loosely must never be read as a yes.
    const provider = new FakeLlmProvider({
      script: [toolCall("review_verdict", { approved: "yes" })],
    });
    const events = await turn(provider)({ task: inReview, actor: grace, kind: AGENT_REVIEW_JOB });

    expect(events[0]?.type).toBe("request_changes");
  });

  it("says nothing when the reviewer never gave a verdict", async () => {
    const provider = new FakeLlmProvider({ script: [reply("thinking about it")] });
    const events = await turn(provider)({ task: inReview, actor: grace, kind: AGENT_REVIEW_JOB });

    expect(events).toEqual([]);
  });

  it("asks the reviewer to review, not to do the work again", async () => {
    const provider = new FakeLlmProvider({
      script: [toolCall("review_verdict", { approved: true })],
    });
    await turn(provider)({ task: inReview, actor: grace, kind: AGENT_REVIEW_JOB });

    const tools = provider.calls[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(tools).toContain(REVIEW_TOOL.name);
    expect(tools).not.toContain(SUBMIT_TOOL.name);
  });
});

describe("paying for what an employee does", () => {
  it("runs through whatever the caller wraps the provider in, so usage is attributed", async () => {
    const provider = new FakeLlmProvider({
      script: [toolCall("submit_work", { summary: "done" })],
    });
    const wrap = vi.fn((inner: LlmProvider) => inner);

    await llmAgentTurn({ provider, wrapProvider: wrap })({
      task: assigned,
      actor: ada,
      kind: AGENT_RUN_JOB,
    });

    expect(wrap).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ employeeId: ada.id, taskId: assigned.id, departmentId: eng.id }),
    );
  });

  it("uses the model the employee is configured with, not a default", async () => {
    const provider = new FakeLlmProvider({
      script: [toolCall("submit_work", { summary: "done" })],
    });
    const haiku: Employee = { ...ada, llm: { ...ada.llm, model: "claude-haiku-4-5-20251001" } };
    await turn(provider)({ task: assigned, actor: haiku, kind: AGENT_RUN_JOB });

    expect(provider.calls[0]?.model).toBe("claude-haiku-4-5-20251001");
  });
});
