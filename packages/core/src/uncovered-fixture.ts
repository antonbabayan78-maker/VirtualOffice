/** Deliberately untested code used to prove the CI coverage gate fails. */
export function classify(n: number): "negative" | "zero" | "positive" {
  if (n < 0) return "negative";
  if (n === 0) return "zero";
  return "positive";
}
