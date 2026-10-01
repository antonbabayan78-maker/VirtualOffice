import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { App } from "../app/App.js";
import { THEME_STORAGE_KEY, ThemeProvider, readStoredChoice, resolveTheme } from "./theme.js";

/**
 * The shell, once it has worked out what it is connected to.
 *
 * It asks its own address whether an office served it before it draws anything,
 * so a test waits for the answer the way somebody opening it does.
 */
const shell = async () => {
  const view = render(
    <ThemeProvider>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </ThemeProvider>,
  );
  await screen.findByRole("navigation", { name: "Sections" });
  return view;
};

function preferDark(dark: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: dark && query.includes("dark"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  preferDark(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme", () => {
  it("follows the machine when nobody has chosen", () => {
    preferDark(true);
    expect(readStoredChoice()).toBe("system");
    expect(resolveTheme("system")).toBe("dark");
  });

  it("puts the dark class on the document when dark is chosen", async () => {
    const user = userEvent.setup();
    await shell();
    expect(document.documentElement).not.toHaveClass("dark");
    await user.click(screen.getByRole("button", { name: /dark theme/i }));
    expect(document.documentElement).toHaveClass("dark");
  });

  it("remembers the choice for the next visit", async () => {
    const user = userEvent.setup();
    const first = await shell();
    await user.click(screen.getByRole("button", { name: /dark theme/i }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    first.unmount();

    // A fresh mount, as a reload would be.
    await shell();
    expect(document.documentElement).toHaveClass("dark");
    expect(screen.getByRole("button", { name: /light theme/i })).toBeInTheDocument();
  });

  it("goes back to light, and remembers that too", async () => {
    const user = userEvent.setup();
    await shell();
    await user.click(screen.getByRole("button", { name: /dark theme/i }));
    await user.click(screen.getByRole("button", { name: /light theme/i }));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("still works where storage is blocked", async () => {
    const denied = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredChoice()).toBe("system");
    await expect(shell()).resolves.toBeDefined();
    denied.mockRestore();
  });
});
