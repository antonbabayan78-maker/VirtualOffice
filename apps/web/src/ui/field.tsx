/**
 * The form furniture both config drawers use: a labelled control and the one
 * input style. Shared so the two drawers cannot drift apart in the small ways
 * that make a settings panel feel like two different products.
 */
import type { ReactNode } from "react";
import { cn } from "./cn.js";

export function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-muted">
      {label}
      {children}
    </label>
  );
}

export const inputClass = cn(
  "rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-ink",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
);

export function Problems({
  problems,
}: {
  readonly problems: readonly { readonly path: string; readonly message: string }[];
}): ReactNode {
  if (problems.length === 0) return null;
  return (
    <ul role="alert" className="rounded-panel border border-border bg-surface-muted p-2 text-xs">
      {problems.map((problem) => (
        <li key={`${problem.path}:${problem.message}`}>
          <span className="font-medium">{problem.path}</span>: {problem.message}
        </li>
      ))}
    </ul>
  );
}
