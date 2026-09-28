/**
 * Theme: light, dark, or whatever the machine prefers.
 *
 * The choice is kept in localStorage and applied as a class on <html>, which is
 * what the token redefinitions in styles.css hang off. A small script in
 * index.html applies the same rule before first paint so a reload does not flash
 * the wrong theme; this module is what keeps it in step afterwards.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export const THEME_STORAGE_KEY = "vo.theme";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeState {
  readonly choice: ThemeChoice;
  readonly resolved: ResolvedTheme;
  // Function properties rather than methods: these get passed around as
  // handlers, and a method signature invites an unbound `this`.
  readonly setChoice: (choice: ThemeChoice) => void;
  /** Flips between light and dark, settling a "system" choice explicitly. */
  readonly toggle: () => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

function prefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function readStoredChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    // Private browsing and blocked storage are not errors worth failing over.
    return "system";
  }
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === "system") return prefersDark() ? "dark" : "light";
  return choice;
}

export function ThemeProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);
  const resolved = resolveTheme(choice);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The theme still applies for this session even if it cannot be saved.
    }
  }, []);

  const value = useMemo<ThemeState>(
    () => ({
      choice,
      resolved,
      setChoice,
      toggle: () => {
        setChoice(resolved === "dark" ? "light" : "dark");
      },
    }),
    [choice, resolved, setChoice],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const state = useContext(ThemeContext);
  if (state === null) throw new Error("useTheme must be used inside a ThemeProvider");
  return state;
}
