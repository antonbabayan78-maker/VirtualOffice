import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names and lets a later one win over an earlier one of the same
 * kind, so a component's defaults can be overridden at the call site without
 * every component growing its own set of variant props.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
