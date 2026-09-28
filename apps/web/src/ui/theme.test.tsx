import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { App } from "../app/App.js";
import { THEME_STORAGE_KEY, ThemeProvider, readStoredChoice, resolveTheme } from "./theme.js";

const shell = () =>
  render(
    <ThemeProvider>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </ThemeProvider>,
  );

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
    shell();
    expect(document.documentElement).not.toHaveClass("dark");
    await user.click(screen.getByRole("button", { name: /dark theme/i }));
    expect(document.documentElement).toHaveClass("dark");
  });

  it("remembers the choice for the next visit", async () => {
    const user = userEvent.setup();
    const first = shell();
    await user.click(screen.getByRole("button", { name: /dark theme/i }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    first.unmount();

    // A fresh mount, as a reload would be.
    shell();
    expect(document.documentElement).toHaveClass("dark");
    expect(screen.getByRole("button", { name: /light theme/i })).toBeInTheDocument();
  });

  it("goes back to light, and remembers that too", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByRole("button", { name: /dark theme/i }));
    await user.click(screen.getByRole("button", { name: /light theme/i }));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("still works where storage is blocked", () => {
    const denied = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredChoice()).toBe("system");
    expect(() => shell()).not.toThrow();
    denied.mockRestore();
  });
});
