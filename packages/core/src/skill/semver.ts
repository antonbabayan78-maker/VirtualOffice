/** Strict major.minor.patch semantic versions (no prefix, no pre-release, no build metadata). */
export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemver(input: unknown): Semver | null {
  if (typeof input !== "string") return null;
  const m = SEMVER.exec(input);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Negative when a < b, zero when equal, positive when a > b. Inputs must be valid. */
export function compareSemver(a: string, b: string): number {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (!va || !vb) throw new Error(`compareSemver: invalid version ${JSON.stringify(!va ? a : b)}`);
  return va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch;
}
