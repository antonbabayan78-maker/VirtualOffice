import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ACTIVITY_STATES, EmployeeAvatar, type ActivityState } from "./EmployeeAvatar.js";

const head = (): SVGPathElement => {
  const path = document.querySelector<SVGPathElement>("[data-part='head']");
  if (path === null) throw new Error("the figure has no head");
  return path;
};

describe("EmployeeAvatar", () => {
  it("says who it is and what they are doing", () => {
    render(<EmployeeAvatar name="Ada" state="working" />);
    expect(screen.getByRole("img", { name: /Ada/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /working/i })).toBeInTheDocument();
  });

  it("gives the head a different colour for every state", () => {
    const fills = new Set<string>();
    for (const state of ACTIVITY_STATES) {
      const view = render(<EmployeeAvatar name="Ada" state={state} />);
      fills.add(head().getAttribute("fill") ?? "");
      view.unmount();
    }
    expect(fills.size).toBe(ACTIVITY_STATES.length);
  });

  it("turns the head green at work, orange when waiting and red on an error", () => {
    const colourOf = (state: ActivityState): string => {
      const view = render(<EmployeeAvatar name="Ada" state={state} />);
      const fill = head().getAttribute("fill") ?? "";
      view.unmount();
      return fill;
    };
    expect(colourOf("working")).toMatch(/working/);
    expect(colourOf("waiting")).toMatch(/waiting/);
    expect(colourOf("error")).toMatch(/error/);
  });

  it("leaves an idle head the office's own ink, which is black in daylight", () => {
    render(<EmployeeAvatar name="Ada" state="idle" />);
    expect(head().getAttribute("fill")).toMatch(/ink/);
  });

  it("pulses while there is something to watch, and rests when idle", () => {
    for (const state of ["working", "waiting", "error"] as const) {
      const view = render(<EmployeeAvatar name="Ada" state={state} />);
      expect(head().dataset["animated"], state).toBe("true");
      view.unmount();
    }
    render(<EmployeeAvatar name="Ada" state="idle" />);
    expect(head().dataset["animated"]).toBe("false");
  });

  it("keeps the body in the office's ink so the figure reads in either theme", () => {
    render(<EmployeeAvatar name="Ada" state="working" />);
    const body = document.querySelector("[data-part='body']");
    expect(body?.getAttribute("fill")).toMatch(/ink/);
  });

  it("can be sized", () => {
    render(<EmployeeAvatar name="Ada" state="idle" size={64} />);
    const figure = screen.getByRole("img", { name: /Ada/ });
    expect(figure).toHaveAttribute("height", "64");
  });
});
