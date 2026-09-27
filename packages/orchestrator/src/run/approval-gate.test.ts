import { describe, expect, it } from "vitest";
import {
  SPEND_APPROVAL_KEY,
  pendingApprovalEffect,
  pendingApprovalFor,
  toolGateFromMap,
  type ApprovalDecision,
  type RunApprovalGate,
} from "./approval-gate.js";
import type { ToolUse } from "./agent-run-loop.js";

const call = (name: string, id = `toolu_${name}`): ToolUse => ({
  type: "tool_use",
  id,
  name,
  input: {},
});

const classify = toolGateFromMap({
  post_message: ["external_send"],
  ship: ["deploy"],
  drop_table: ["delete", "deploy"],
});

const gate = (overrides: Partial<RunApprovalGate> = {}): RunApprovalGate => ({
  gatedActions: ["deploy", "delete"],
  classify,
  ...overrides,
});

const clean = { spentUsd: 0, spendApproved: false };
const approve = (key: string): ApprovalDecision => ({
  key,
  decision: "approved",
  decidedBy: "anton@example.com",
});

describe("toolGateFromMap", () => {
  it("classifies a known tool and leaves everything else ungated", () => {
    expect(classify(call("ship"))).toEqual(["deploy"]);
    expect(classify(call("get_diff"))).toEqual([]);
  });
});

describe("pendingApprovalFor", () => {
  it("holds nothing when no call touches a gated category", () => {
    expect(pendingApprovalFor([call("get_diff")], gate(), clean, [])).toBeNull();
  });

  it("holds nothing when the call's category is not one this gate covers", () => {
    const outside = gate({ gatedActions: ["spend"] });
    expect(pendingApprovalFor([call("ship")], outside, clean, [])).toBeNull();
  });

  it("lists a gated call with the categories the gate covers, in the gate's order", () => {
    const pending = pendingApprovalFor([call("drop_table")], gate(), clean, []);
    expect(pending?.items).toEqual([
      {
        key: "toolu_drop_table",
        name: "drop_table",
        gates: ["deploy", "delete"],
        detail: 'tool "drop_table" (deploy, delete)',
      },
    ]);
    expect(pending?.gates).toEqual(["deploy", "delete"]);
    expect(pending?.summary).toMatch(/drop_table/);
  });

  it("lists every gated call in the turn and ignores the ungated ones", () => {
    const pending = pendingApprovalFor(
      [call("get_diff"), call("ship"), call("post_message")],
      gate(),
      clean,
      [],
    );
    expect(pending?.items.map((i) => i.name)).toEqual(["ship"]);
  });

  it("holds nothing once every gated call has been decided, either way", () => {
    const decided: ApprovalDecision[] = [
      approve("toolu_ship"),
      { key: "toolu_drop_table", decision: "declined", decidedBy: "anton", reason: "no" },
    ];
    expect(
      pendingApprovalFor([call("ship"), call("drop_table")], gate(), clean, decided),
    ).toBeNull();
  });

  it("still holds while one call of several is undecided", () => {
    const pending = pendingApprovalFor([call("ship"), call("drop_table")], gate(), clean, [
      approve("toolu_ship"),
    ]);
    expect(pending?.items.map((i) => i.name)).toEqual(["drop_table"]);
  });
});

describe("pendingApprovalFor: the spend threshold", () => {
  const spending = gate({ gatedActions: ["spend", "deploy"], spendThresholdUsd: 0.5 });

  it("asks once the run's cost reaches the threshold", () => {
    const pending = pendingApprovalFor(
      [call("get_diff")],
      spending,
      {
        spentUsd: 0.5,
        spendApproved: false,
      },
      [],
    );
    expect(pending?.items.map((i) => i.key)).toEqual([SPEND_APPROVAL_KEY]);
    expect(pending?.gates).toEqual(["spend"]);
    expect(pending?.items[0]?.detail).toMatch(/0\.50/);
  });

  it("stays quiet below the threshold", () => {
    expect(
      pendingApprovalFor(
        [call("get_diff")],
        spending,
        { spentUsd: 0.49, spendApproved: false },
        [],
      ),
    ).toBeNull();
  });

  it("asks only once per run, however far the cost goes past it", () => {
    expect(
      pendingApprovalFor([call("get_diff")], spending, { spentUsd: 9, spendApproved: true }, []),
    ).toBeNull();
  });

  it("stays quiet when the department does not gate spend", () => {
    const noSpend = gate({ gatedActions: ["deploy"], spendThresholdUsd: 0.5 });
    expect(
      pendingApprovalFor([call("get_diff")], noSpend, { spentUsd: 9, spendApproved: false }, []),
    ).toBeNull();
  });

  it("asks about the cost and the call together when both need a person", () => {
    const pending = pendingApprovalFor(
      [call("ship")],
      spending,
      {
        spentUsd: 1,
        spendApproved: false,
      },
      [],
    );
    expect(pending?.items.map((i) => i.key)).toEqual([SPEND_APPROVAL_KEY, "toolu_ship"]);
    expect(pending?.gates).toEqual(["spend", "deploy"]);
  });
});

describe("pendingApprovalEffect", () => {
  it("feeds the same approvals inbox the review gate uses", () => {
    const pending = pendingApprovalFor([call("drop_table")], gate(), clean, []);
    if (!pending) throw new Error("expected a pending approval");
    expect(pendingApprovalEffect(pending)).toEqual({
      type: "request_approval",
      gates: ["deploy", "delete"],
      summary: pending.summary,
    });
  });
});
