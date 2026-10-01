import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "../ui/theme.js";
import { App } from "./App.js";
import { ROUTES } from "./routes.js";
import { officeStore } from "../office/store.js";

/**
 * The shell, once it knows what it is connected to.
 *
 * A canvas the office served carries no token, so the first thing it does is
 * ask its own address whether an office is there — which makes mounting it an
 * await, the way opening it is a moment.
 */
async function mount(at = "/") {
  const view = render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[at]}>
        <App />
      </MemoryRouter>
    </ThemeProvider>,
  );
  await screen.findByRole("navigation", { name: "Sections" });
  return view;
}

describe("the shell", () => {
  it("renders the office and its sections", async () => {
    await mount();
    expect(screen.getByText("Virtual Office")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Sections" });
    for (const route of ROUTES) {
      expect(within(nav).getByRole("link", { name: route.label })).toBeInTheDocument();
    }
  });

  it("opens on the canvas", async () => {
    await mount();
    // The canvas itself, not a page about the canvas.
    expect(screen.getByRole("checkbox", { name: /snap to grid/i })).toBeInTheDocument();
  });

  it("shows each section at its own address", async () => {
    for (const route of ROUTES.filter((r) => r.path !== "/")) {
      const view = await mount(route.path);
      expect(screen.getByRole("heading", { name: route.title })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("marks the section you are looking at", async () => {
    await mount("/tasks");
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(within(nav).getByRole("link", { name: "Tasks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("navigates without a reload", async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole("link", { name: "Usage" }));
    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
    // And back to the canvas.
    await user.click(screen.getByRole("link", { name: "Canvas" }));
    expect(screen.getByRole("checkbox", { name: /snap to grid/i })).toBeInTheDocument();
  });

  it("says so plainly for an address that is not part of the office", async () => {
    await mount("/nowhere");
    expect(screen.getByRole("heading", { name: "Nothing here" })).toBeInTheDocument();
  });
});

describe("the office the whole application shares", () => {
  // Stated rather than inherited: with a VITE_VO_API_URL in the environment —
  // which a developer running against a local server will have — the shell
  // would try to reach that office instead of loading the sample one, and this
  // suite would pass or fail depending on whose machine it ran on.
  beforeEach(() => {
    for (const name of ["VITE_VO_API_URL", "VITE_VO_API_TOKEN", "VITE_VO_OFFICE_ID"]) {
      vi.stubEnv(name, "");
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is loaded even when the canvas was never opened", async () => {
    // It used to be loaded by the canvas, so landing anywhere else gave an
    // empty store and a section that looked broken.
    officeStore.setState({ departments: [], employees: [] });
    const view = await mount("/usage");

    expect(officeStore.getState().departments.length).toBeGreaterThan(0);
    view.unmount();
  });

  it("is still loaded when the canvas is opened", async () => {
    officeStore.setState({ departments: [], employees: [] });
    const view = await mount("/");

    expect(officeStore.getState().departments.length).toBeGreaterThan(0);
    view.unmount();
  });

  it("is not reloaded when moving between sections", async () => {
    // Switching tabs used to tear the stream down and build it again.
    officeStore.setState({ departments: [], employees: [] });
    await mount("/");
    const loaded = officeStore.getState().departments;

    await userEvent.setup().click(screen.getByRole("link", { name: "Usage" }));
    expect(officeStore.getState().departments).toBe(loaded);
  });
});

describe("the usage section", () => {
  beforeEach(() => {
    for (const name of ["VITE_VO_API_URL", "VITE_VO_API_TOKEN", "VITE_VO_OFFICE_ID"]) {
      vi.stubEnv(name, "");
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the figures themselves, not a page about them", async () => {
    // It was an explicit placeholder saying "Not built yet"; the data behind it
    // has existed since telemetry reached the server.
    const view = await mount("/usage");
    expect(screen.getByRole("group", { name: /what this office has spent/i })).toBeTruthy();
    expect(screen.queryByText(/not built yet/i)).toBeNull();
    view.unmount();
  });
});
