import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Budget } from "@vo/core";
import { BudgetField } from "./BudgetField.js";

interface Options {
  readonly value?: Budget | null;
  readonly spentUsd?: number;
}

/**
 * Holds the value the way a drawer's draft does. A fixed prop would make every
 * keystroke re-render the old value, so typing "25" would arrive as "5" — an
 * artefact of the harness rather than anything the component does.
 */
function mount({ value = null, spentUsd }: Options = {}) {
  cleanup();
  const onChange = vi.fn();
  function Harness() {
    const [budget, setBudget] = useState<Budget | null>(value);
    return (
      <BudgetField
        what="office"
        value={budget}
        {...(spentUsd === undefined ? {} : { spentUsd })}
        onChange={(next) => {
          onChange(next);
          setBudget(next);
        }}
      />
    );
  }
  render(<Harness />);
  return onChange;
}

const panel = () => screen.getByRole("group", { name: /spending limit/i });
const limit = () => screen.getByLabelText(/^Limit/);

describe("setting a spending limit", () => {
  it("has none to begin with", () => {
    mount();
    expect(limit()).toHaveValue("");
  });

  it("says plainly that there is no limit, rather than showing an empty box", () => {
    mount();
    expect(panel()).toHaveTextContent(/no limit|spends what it needs/i);
  });

  it("sets one", async () => {
    const onChange = mount();
    await userEvent.setup().type(limit(), "25");

    expect(onChange).toHaveBeenLastCalledWith({
      limitUsd: 25,
      warnAtUsd: null,
      period: "day",
    });
  });

  it("takes one away when the limit is cleared", async () => {
    const onChange = mount({ value: { limitUsd: 25, warnAtUsd: null, period: "day" } });
    await userEvent.setup().clear(limit());

    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("offers a day and a month", async () => {
    const onChange = mount({ value: { limitUsd: 25, warnAtUsd: null, period: "day" } });
    await userEvent.setup().selectOptions(screen.getByLabelText(/^Period/), "month");

    expect(onChange).toHaveBeenLastCalledWith({
      limitUsd: 25,
      warnAtUsd: null,
      period: "month",
    });
  });

  it("sets a warning below the limit", async () => {
    const onChange = mount({ value: { limitUsd: 25, warnAtUsd: null, period: "day" } });
    await userEvent.setup().type(screen.getByLabelText(/^Warn/), "20");

    expect(onChange).toHaveBeenLastCalledWith({
      limitUsd: 25,
      warnAtUsd: 20,
      period: "day",
    });
  });

  it("says what happens when the limit is reached, which is not obvious", () => {
    // Somebody setting this needs to know whether it pauses people or stops
    // work by itself, because those need very different reactions.
    mount({ value: { limitUsd: 25, warnAtUsd: null, period: "day" } });
    expect(panel()).toHaveTextContent(/picks up nothing|stops.*until|starts again/i);
  });

  it("does not offer a warning when there is no limit to warn about", () => {
    mount();
    expect(screen.queryByLabelText(/^Warn/)).toBeNull();
  });
});

describe("what has been spent against it", () => {
  const budget: Budget = { limitUsd: 25, warnAtUsd: 20, period: "day" };

  it("says nothing about spend when there is no limit", () => {
    mount({ spentUsd: 9 });
    expect(panel()).not.toHaveTextContent("$9");
  });

  it("shows what has gone against the limit", () => {
    mount({ value: budget, spentUsd: 9 });
    expect(panel()).toHaveTextContent("$9.00");
    expect(panel()).toHaveTextContent("$25.00");
  });

  it("says when it is near the warning, before it is reached", () => {
    mount({ value: budget, spentUsd: 21 });
    expect(panel()).toHaveTextContent(/near|warning/i);
  });

  it("says when work has stopped, which is the thing worth noticing", () => {
    mount({ value: budget, spentUsd: 25 });
    expect(panel()).toHaveTextContent(/stopped|reached/i);
  });

  it("says when it has not been told what was spent, rather than showing nothing", () => {
    // Zero and unknown look identical, and one of them means the office could
    // not be asked.
    mount({ value: budget });
    expect(panel()).not.toHaveTextContent("$0.00");
  });
});
