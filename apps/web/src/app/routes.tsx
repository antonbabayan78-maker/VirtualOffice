/**
 * The shell's destinations. Each one is a placeholder until the task that owns
 * it lands; they exist now so the router, the navigation and the layout are
 * real and tested rather than arriving with the first feature.
 */
import type { ReactNode } from "react";

export interface RouteDefinition {
  readonly path: string;
  readonly label: string;
  readonly title: string;
  readonly description: string;
}

export const ROUTES: readonly RouteDefinition[] = [
  {
    path: "/",
    label: "Canvas",
    title: "Office canvas",
    description: "Departments, employees and the connections between them.",
  },
  {
    path: "/tasks",
    label: "Tasks",
    title: "Tasks",
    description: "What every department is working on, and how far along it is.",
  },
  {
    path: "/approvals",
    label: "Approvals",
    title: "Approvals",
    description: "Work waiting on a decision only a person can make.",
  },
  {
    path: "/proposals",
    label: "Proposals",
    title: "Proposals",
    description: "Changes this office would make to how its own people work.",
  },
  {
    path: "/usage",
    label: "Usage",
    title: "Usage",
    description: "Tokens and cost, by model, employee and department.",
  },
];

export function Placeholder({ route }: { readonly route: RouteDefinition }): ReactNode {
  return (
    <section className="flex h-full flex-col items-start gap-2 p-8">
      <h1 className="text-xl font-semibold text-ink">{route.title}</h1>
      <p className="max-w-prose text-sm text-ink-muted">{route.description}</p>
      <p className="mt-4 rounded-panel border border-border bg-surface px-3 py-2 text-xs text-ink-muted">
        Not built yet — this is the shell it will live in.
      </p>
    </section>
  );
}
