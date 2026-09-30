import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunSwitch } from "./RunSwitch.js";

interface Options {
  readonly running?: boolean;
  readonly what?: "office" | "department" | "person";
  readonly onChange?: (to: boolean) => void;
}

function mount({ running = true, what = "office", onChange = vi.fn() }: Options = {}) {
  cleanup();
  const spy = vi.fn(onChange);
  render(<RunSwitch what={what} running={running} onChange={spy} />);
  return spy;
}

const box = () => screen.getByRole("checkbox");

describe("the switch that stops work", () => {
  it("is on when work is running", () => {
    mount();
    expect(box()).toBeChecked();
  });

  it("is off when somebody stopped it", () => {
    mount({ running: false });
    expect(box()).not.toBeChecked();
  });

  it("stops work when it is switched off", async () => {
    const onChange = mount();
    await userEvent.setup().click(box());
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("starts work again when it is switched back on", async () => {
    const onChange = mount({ running: false });
    await userEvent.setup().click(box());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("says what stopping it would stop, which differs by what it is", () => {
    // "Nothing here will be picked up" is true of a person and wrong about an
    // office; the reader needs to know the blast radius before they press it.
    mount({ what: "office" });
    const office = screen.getByRole("group").textContent;
    mount({ what: "person" });
    const person = screen.getByRole("group").textContent;

    expect(office).not.toBe(person);
  });

  it("says plainly that it is stopped, not only by an unticked box", () => {
    // A box that is merely unticked reads as a setting nobody turned on.
    mount({ running: false });
    expect(screen.getByRole("group")).toHaveTextContent(/stopped|paused/i);
  });

  it("does not claim work is running when the hours may still be against it", () => {
    // The switch is not the schedule. Saying "working" here would be a promise
    // this control cannot keep.
    mount();
    expect(screen.getByRole("group")).not.toHaveTextContent(/working now|is working/i);
  });
});
