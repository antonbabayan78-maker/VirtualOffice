/**
 * The application shell: a title bar, the navigation, and whatever route is
 * showing. Deliberately thin — the canvas and the drawers arrive as their own
 * tasks and mount inside this.
 *
 * In front of it, the session: a canvas the office served has no token in it,
 * so the first thing it does is ask whether it is signed in, and the shell is
 * what it shows once it is and knows which office it is for.
 */
import type { ReactNode } from "react";
import { NavLink, Route, Routes } from "react-router";
import { Button } from "../ui/button.js";
import { cn } from "../ui/cn.js";
import { useTheme } from "../ui/theme.js";
import { Placeholder, ROUTES, type RouteDefinition } from "./routes.js";
import { CanvasScreen } from "../canvas/CanvasScreen.js";
import { officeStore } from "../office/store.js";
import { useOffice, type OfficePlan } from "../office/useOffice.js";
import { ApprovalsScreen } from "../approvals/ApprovalsScreen.js";
import { TasksScreen } from "../tasks/TasksScreen.js";
import { UsageScreen } from "../usage/UsageScreen.js";
import { ChooseOffice } from "./ChooseOffice.js";
import { SignIn } from "./SignIn.js";
import { useSession } from "./useSession.js";
import type { SessionDeps } from "./session.js";

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

/** The screen a section shows; the rest are still their own tasks. */
function screenFor(route: RouteDefinition): ReactNode {
  if (route.path === "/") return <CanvasScreen />;
  if (route.path === "/usage") return <UsageScreen store={officeStore} />;
  if (route.path === "/approvals") return <ApprovalsScreen store={officeStore} />;
  if (route.path === "/tasks") return <TasksScreen store={officeStore} />;
  return <Placeholder route={route} />;
}

/**
 * How much is waiting on a person, on the link to where it is answered.
 *
 * The only thing in the shell that counts anything, and it earns it: work that
 * stops for a person stops silently otherwise — the canvas shows somebody
 * waiting, which looks like somebody working from across the room.
 */
function WaitingCount({ path }: { readonly path: string }): ReactNode {
  const waiting = officeStore((state) => state.waiting.length);
  if (path !== "/approvals" || waiting === 0) return null;
  return (
    <span
      aria-label={`${String(waiting)} waiting`}
      className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-canvas tabular-nums"
    >
      {waiting}
    </span>
  );
}

export function App({
  session: deps,
}: { readonly session?: Partial<SessionDeps> } = {}): ReactNode {
  const { session, signIn, createOffice, openOffice, signOut } = useSession(deps ?? {});

  if (session === null) {
    return (
      <main className="flex h-full items-center justify-center bg-canvas p-6 text-ink">
        <p className="text-xs text-ink-muted">Finding the office…</p>
      </main>
    );
  }

  if (session.kind === "signIn") {
    return <SignIn onSignIn={signIn} problem={session.problem} />;
  }

  if (session.kind === "choose") {
    return (
      <ChooseOffice
        offices={session.offices}
        onOpen={openOffice}
        onCreate={createOffice}
        onSignOut={() => void signOut()}
      />
    );
  }

  return (
    <Shell
      plan={
        session.kind === "sample" ? { kind: "sample" } : { kind: "office", config: session.config }
      }
      // Only for a browser that signed in: a canvas configured with a token of
      // its own has nothing here to give back.
      onSignOut={
        session.kind === "ready" && session.config.token === undefined ? () => signOut() : null
      }
    />
  );
}

function Shell({
  plan,
  onSignOut,
}: {
  readonly plan: OfficePlan;
  readonly onSignOut: (() => Promise<void>) | null;
}): ReactNode {
  // Above the router on purpose: moving between sections must not reload the
  // office, and landing on any address should find the same data as landing on
  // the canvas.
  const problem = useOffice(officeStore, plan);

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
              <WaitingCount path={route.path} />
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {onSignOut !== null && (
            <Button
              aria-label="Sign out"
              onClick={() => {
                void onSignOut();
              }}
            >
              Sign out
            </Button>
          )}
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
              <Route key={route.path} path={route.path} element={screenFor(route)} />
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
