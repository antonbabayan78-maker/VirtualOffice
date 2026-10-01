/**
 * Who is calling.
 *
 * A bearer token names an owner, and everything else about identity — users,
 * sessions, scopes — belongs to a task that is actually about identity. What
 * matters here is that a request without a valid token never reaches a route,
 * so no endpoint has to remember to check.
 */
export interface Principal {
  readonly ownerId: string;
}

export type TokenVerifier = (token: string) => Principal | null;

/** The token from an Authorization header, or null when there is not one. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** A verifier over a fixed set of tokens, which is what a deployment configures. */
export function tokenVerifier(tokens: Readonly<Record<string, Principal>>): TokenVerifier {
  return (token) => {
    if (token.length === 0) return null;
    return tokens[token] ?? null;
  };
}

/**
 * The cookie a browser signs in with.
 *
 * It carries the office token, so that a page can hold no credential at all:
 * not in its bundle, not in storage, and not in the WebSocket URL it used to
 * put one in. `HttpOnly` is what script on the page cannot read, and `Strict` is
 * what nobody else's page can send — which is what stands in for a CSRF token
 * here, with every write route already wanting JSON.
 *
 * It is the token rather than a session of its own, which means signing out
 * clears this browser and nothing else. Sessions with an id, an expiry and a way
 * to revoke one belong to a task about identity.
 */
export const SESSION_COOKIE = "vo_session";

/** A month: long enough not to be a nuisance, short enough to lapse. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** The session token out of a Cookie header, or null when it is not in there. */
export function sessionCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    if (pair.slice(0, at).trim() !== SESSION_COOKIE) continue;
    // Quoted when the value has anything unusual in it, and escaped because the
    // token is whatever somebody configured.
    const raw = pair.slice(at + 1).trim();
    const value = decodeURIComponent(raw.replace(/^"(.*)"$/, "$1").trim());
    return value.length === 0 ? null : value;
  }
  return null;
}

export interface SessionCookieOptions {
  /** Https, which is the only time a browser should keep this at all — except
   * on a plain-http localhost, where marking it secure means it is dropped and
   * signing in appears to work and never does. */
  readonly secure: boolean;
}

export function sessionCookieHeader(token: string, options: SessionCookieOptions): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${String(SESSION_MAX_AGE_SECONDS)}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/** The same cookie, already expired: how a browser is asked to forget one. */
export function clearedSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Strict"].join("; ");
}
