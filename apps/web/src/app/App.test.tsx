import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "../ui/theme.js";
import { App } from "./App.js";
import { ROUTES } from "./routes.js";

function mount(at = "/") {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[at]}>
        <App />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("the shell", () => {
  it("renders the office and its sections", () => {
    mount();
    expect(screen.getByText("Virtual Office")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Sections" });
    for (const route of ROUTES) {
      expect(within(nav).getByRole("link", { name: route.label })).toBeInTheDocument();
    }
  });

  it("opens on the canvas", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Office canvas" })).toBeInTheDocument();
  });

  it("shows each section at its own address", () => {
    for (const route of ROUTES) {
      const view = mount(route.path);
      expect(screen.getByRole("heading", { name: route.title })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("marks the section you are looking at", () => {
    mount("/tasks");
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(within(nav).getByRole("link", { name: "Tasks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("navigates without a reload", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("link", { name: "Usage" }));
    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
  });

  it("says so plainly for an address that is not part of the office", () => {
    mount("/nowhere");
    expect(screen.getByRole("heading", { name: "Nothing here" })).toBeInTheDocument();
  });
});
