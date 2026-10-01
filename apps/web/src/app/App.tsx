/**
 * The application shell: a title bar, the navigation, and whatever route is
 * showing. Deliberately thin — the canvas and the drawers arrive as their own
 * tasks and mount inside this.
 */
import type { ReactNode } from "react";
import { NavLink, Route, Routes } from "react-router";
import { Button } from "../ui/button.js";
import { cn } from "../ui/cn.js";
import { useTheme } from "../ui/theme.js";
import { Placeholder, ROUTES } from "./routes.js";
import { CanvasScreen } from "../canvas/CanvasScreen.js";
import { officeStore } from "../office/store.js";
import { useOffice } from "../office/useOffice.js";

function ThemeToggle(): ReactNode {
  const { resolved, toggle } = useTheme();
  return (
    <Button
      onClick={toggle}
      aria-label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    >
      {resolved === "dark" ? "Light" : "Dark"}
    </Button>
  );
}

export function App(): ReactNode {
  // Above the router on purpose: moving between sections must not reload the
  // office, and landing on any address should find the same data as landing on
  // the canvas.
  const problem = useOffice(officeStore);

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex items-center gap-4 border-b border-border bg-surface px-4 py-2">
        <span className="text-sm font-semibold tracking-tight">Virtual Office</span>
        <nav aria-label="Sections" className="flex items-center gap-1">
          {ROUTES.map((route) => (
            <NavLink
              key={route.path}
              to={route.path}
              end={route.path === "/"}
              className={({ isActive }) =>
                cn(
                  "rounded-lg px-3 py-1.5 text-sm",
                  isActive ? "bg-surface-muted font-medium text-ink" : "text-ink-muted",
                )
              }
            >
              {route.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        {problem !== null ? (
          <section className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <h1 className="text-sm font-medium text-ink">This office will not open</h1>
            <p className="max-w-md text-xs text-ink-muted">{problem}</p>
          </section>
        ) : (
          <Routes>
            {ROUTES.map((route) => (
              <Route
                key={route.path}
                path={route.path}
                element={route.path === "/" ? <CanvasScreen /> : <Placeholder route={route} />}
              />
            ))}
            <Route
              path="*"
              element={
                <section className="p-8">
                  <h1 className="text-xl font-semibold">Nothing here</h1>
                  <p className="text-sm text-ink-muted">That address is not part of the office.</p>
                </section>
              }
            />
          </Routes>
        )}
      </main>
    </div>
  );
}
