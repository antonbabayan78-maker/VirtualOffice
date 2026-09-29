/**
 * Which addresses an office lets its employees reach.
 *
 * Every rule here exists because the obvious version of it is wrong, and each
 * one has a test saying so. Matching is on the parsed hostname and never on the
 * URL as text: `https://acme.test@evil.test/` is a request to evil.test, and
 * `https://evil.test/?ref=acme.test` is a request to evil.test. Suffix matching
 * with `endsWith` lets `evil-acme.test` through, so a subdomain has to be asked
 * for with a wildcard.
 *
 * Addresses inside the building are refused whether or not they were named. An
 * office that allowlists its own metadata service has made a mistake, and the
 * useful response is to refuse rather than to obey — that one address is how a
 * fetched page turns into cloud credentials.
 *
 * What this does NOT close: the check is on the name, and the connection
 * resolves the name again, so a host that answers differently the second time
 * is not caught. Closing it needs a dispatcher pinned to the address that was
 * checked. The threat this defends against is an office reaching somewhere it
 * should not; a page that tries to steer the agent is a different problem,
 * handled by fencing fetched text as untrusted material where it is read.
 */

export interface WebPolicy {
  /** Hosts, each either an exact name or `*.name` for its subdomains. */
  readonly hosts: readonly string[];
  /** Off by default: an office reaching plain http has usually not meant to. */
  readonly allowPlainHttp: boolean;
}

export type Verdict =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Names that never leave the building, however they are spelled. */
const INSIDE = /^(localhost|.*\.localhost|.*\.internal|.*\.local)$/;

function isInside(host: string): boolean {
  if (INSIDE.test(host)) return true;
  // IPv6 arrives bracketed; only loopback and unspecified are worth naming.
  if (host.startsWith("[")) return host === "[::1]" || host === "[::]";

  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local, which is where a cloud instance keeps its credentials.
  if (a === 169 && b === 254) return true;
  return false;
}

/** Lowercased, without the trailing dot that means the same host. */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

function matches(host: string, pattern: string): boolean {
  const wanted = normalizeHost(pattern);
  if (wanted.startsWith("*.")) {
    const suffix = wanted.slice(1); // ".acme.test", dot included on purpose
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === wanted;
}

export function isAllowed(raw: string, policy: WebPolicy): Verdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: `"${raw}" is not an address.` };
  }

  const scheme = url.protocol;
  if (scheme !== "https:" && !(scheme === "http:" && policy.allowPlainHttp)) {
    return {
      allowed: false,
      reason: `${scheme} is not a scheme this office fetches; it reaches https addresses.`,
    };
  }

  const host = normalizeHost(url.hostname);
  if (isInside(host)) {
    return { allowed: false, reason: `${host} is inside the building and is never fetched.` };
  }
  if (!policy.hosts.some((pattern) => matches(host, pattern))) {
    return { allowed: false, reason: `this office does not allow ${host}.` };
  }
  return { allowed: true };
}

/** A policy out of a connector's configuration, which is untyped by design. */
export function parseAllowlist(config: Readonly<Record<string, unknown>>): WebPolicy {
  const raw = config["hosts"];
  // An allowlist that says nothing allows nothing. The other way round is how a
  // connector added in a hurry reaches the whole internet.
  const hosts = Array.isArray(raw)
    ? raw.filter((host): host is string => typeof host === "string" && host.length > 0)
    : [];
  return { hosts, allowPlainHttp: config["allowPlainHttp"] === true };
}
