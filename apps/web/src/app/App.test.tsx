import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
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

  /**
   * The nav appearing means the shell knows what it is connected to; the office
   * arrives in the store a tick later, when the effect that loads it runs.
   * Asserting straight after the nav is a race that only shows up on a busy
   * machine — which CI is, and this laptop is not.
   */
  const loaded = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(officeStore.getState().departments.length).toBeGreaterThan(0);
    });
  };

  it("is loaded even when the canvas was never opened", async () => {
    // It used to be loaded by the canvas, so landing anywhere else gave an
    // empty store and a section that looked broken.
    officeStore.setState({ departments: [], employees: [] });
    const view = await mount("/usage");

    await loaded();
    view.unmount();
  });

  it("is still loaded when the canvas is opened", async () => {
    officeStore.setState({ departments: [], employees: [] });
    const view = await mount("/");

    await loaded();
    view.unmount();
  });

  it("is not reloaded when moving between sections", async () => {
    // Switching tabs used to tear the stream down and build it again.
    officeStore.setState({ departments: [], employees: [] });
    await mount("/");
    await loaded();
    const held = officeStore.getState().departments;

    await userEvent.setup().click(screen.getByRole("link", { name: "Usage" }));
    expect(officeStore.getState().departments).toBe(held);
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

describe("how much is waiting on a person", () => {
  const held = {
    kind: "call" as const,
    taskId: "task-1",
    title: "Tell the customer",
    departmentId: "dept-post",
    assigneeId: "emp-ada",
    since: new Date("2026-10-03T09:00:00Z"),
    key: "toolu_1",
    name: "post__send_email",
    input: { to: "customer@acme.test" },
    gates: ["external_send"],
    detail: 'tool "post__send_email" (external_send)',
  };

  beforeEach(() => {
    for (const name of ["VITE_VO_API_URL", "VITE_VO_API_TOKEN", "VITE_VO_OFFICE_ID"]) {
      vi.stubEnv(name, "");
    }
    officeStore.setState({ waiting: [] });
  });
  afterEach(() => {
    officeStore.setState({ waiting: [] });
    vi.unstubAllEnvs();
  });

  const approvals = () =>
    within(screen.getByRole("navigation", { name: "Sections" })).getByRole("link", {
      name: /approvals/i,
    });

  it("says nothing on the link when nothing is waiting", async () => {
    const view = await mount("/");

    expect(approvals()).toHaveTextContent(/^Approvals$/);
    view.unmount();
  });

  it("counts it on the link, which is how anybody finds out", async () => {
    const view = await mount("/");

    act(() => {
      officeStore.setState({ waiting: [held, { ...held, key: "toolu_2" }] });
    });

    expect(approvals()).toHaveTextContent("2");
    view.unmount();
  });

  it("counts down again as things are answered, without a reload", async () => {
    const view = await mount("/");
    act(() => {
      officeStore.setState({ waiting: [held] });
    });
    expect(approvals()).toHaveTextContent("1");

    act(() => {
      officeStore.setState({ waiting: [] });
    });

    expect(approvals()).toHaveTextContent(/^Approvals$/);
    view.unmount();
  });

  it("shows the inbox at its own address, rather than a page about it", async () => {
    officeStore.setState({ waiting: [held] });
    const view = await mount("/approvals");

    expect(screen.getByRole("region", { name: "Approvals" })).toHaveTextContent("post__send_email");
    expect(screen.queryByText(/not built yet/i)).toBeNull();
    view.unmount();
  });
});

describe("the board, at its own address", () => {
  beforeEach(() => {
    for (const name of ["VITE_VO_API_URL", "VITE_VO_API_TOKEN", "VITE_VO_OFFICE_ID"]) {
      vi.stubEnv(name, "");
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows the lanes rather than a page about them", async () => {
    const view = await mount("/tasks");

    expect(screen.getByRole("region", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.queryByText(/not built yet/i)).toBeNull();
    view.unmount();
  });
});
