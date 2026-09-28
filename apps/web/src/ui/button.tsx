import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn.js";

export type ButtonVariant = "primary" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:opacity-90",
  ghost: "text-ink-muted hover:bg-surface-muted hover:text-ink",
};

export function Button({ variant = "ghost", className, ...props }: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
