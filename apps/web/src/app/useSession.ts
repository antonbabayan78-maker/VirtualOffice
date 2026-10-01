/**
 * The session, as the shell holds it: what to show, and the four things
 * somebody can do about it.
 *
 * The decisions live in `session.ts` and are tested without a browser. This is
 * the state around them — including the one thing the browser does keep, which
 * is the id of the office it opened last time. An id is not a secret; the
 * credential is a cookie this page cannot read.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createApiClient, type ApiClient } from "@vo/api-client";
import { officeConfig, resolveSession, type Session, type SessionDeps } from "./session.js";

const REMEMBERED = "vo.office";

/** Storage that is allowed to be missing: a private window has none. */
function remembered(): string | null {
  try {
    return globalThis.localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
}

function remember(officeId: string): void {
  try {
    globalThis.localStorage.setItem(REMEMBERED, officeId);
  } catch {
    // Nothing to do about it: the canvas asks again next time.
  }
}

export interface SessionState {
  /** Null while the canvas is still finding out what it is connected to. */
  readonly session: Session | null;
  /** Answers with what went wrong, or null when it worked. */
  readonly signIn: (token: string) => Promise<string | null>;
  readonly createOffice: (name: string) => Promise<string | null>;
  readonly openOffice: (officeId: string) => void;
  readonly signOut: () => Promise<void>;
}

export function useSession(deps: Partial<SessionDeps> = {}): SessionState {
  const [session, setSession] = useState<Session | null>(null);
  const { env, origin, probe, createClient } = deps;

  const resolve = useCallback(async (): Promise<Session> => {
    const next = await resolveSession({
      env: env ?? import.meta.env,
      origin: origin ?? globalThis.location.origin,
      remembered,
      ...(probe === undefined ? {} : { probe }),
      ...(createClient === undefined ? {} : { createClient }),
    });
    setSession(next);
    return next;
  }, [env, origin, probe, createClient]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  /** The client for the office that served this page, once there is one. */
  const clientFor = useRef(createClient ?? ((baseUrl: string) => createApiClient({ baseUrl })));
  const api = (): ApiClient | null => {
    if (session === null || session.kind === "sample" || session.kind === "ready") return null;
    return clientFor.current(session.address.baseUrl);
  };

  return {
    session,

    signIn: async (token) => {
      const client = api();
      if (client === null) return "there is no office here to sign in to";
      const signedIn = await client.signIn(token);
      if (!signedIn.ok) {
        return signedIn.kind === "unauthorized"
          ? "that is not a token this office knows"
          : signedIn.kind === "transport"
            ? signedIn.message
            : "the office would not take that token";
      }
      await resolve();
      return null;
    },

    createOffice: async (name) => {
      const client = api();
      if (client === null) return "there is no office here to add to";
      const made = await client.createOffice(name);
      if (!made.ok) {
        return made.kind === "validation"
          ? made.errors.map((error) => error.message).join("; ")
          : "the office would not be made";
      }
      remember(made.value.id);
      await resolve();
      return null;
    },

    openOffice: (officeId) => {
      remember(officeId);
      setSession((current) =>
        current !== null && current.kind === "choose"
          ? { kind: "ready", config: officeConfig(current.address, officeId) }
          : current,
      );
    },

    signOut: async () => {
      // From wherever the cookie got somebody to: the office picker counts, and
      // a canvas configured with a token has nothing to sign out of.
      const where =
        session === null
          ? null
          : session.kind === "choose" || session.kind === "signIn"
            ? session.address.baseUrl
            : session.kind === "ready" && session.config.token === undefined
              ? session.config.baseUrl
              : null;
      if (where === null) return;
      await clientFor.current(where).signOut();
      await resolve();
    },
  };
}
