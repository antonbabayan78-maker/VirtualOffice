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
