/**
 * What the canvas should show before it shows an office.
 *
 * The same bundle runs three ways, and this is where it finds out which:
 *
 * 1. **Configured.** `VITE_VO_API_URL` and a token name an office somewhere
 *    else — a canvas somebody runs themselves, against a deployed office.
 * 2. **Served.** An office answered at this page's own address, so there is
 *    nothing to configure: the browser signs in and the office sets a cookie it
 *    cannot read. Nothing in the page holds a credential, which is the whole
 *    reason an office can serve its own canvas at all.
 * 3. **Neither.** The sample office, so `pnpm dev` with nothing running still
 *    draws something — the rule the canvas has always followed.
 *
 * Kept apart from the component that draws it because these are decisions, and
 * decisions are worth testing without a browser. The component asks this what to
 * show and shows it.
 */
import type { ApiClient } from "@vo/api-client";
import type { Office } from "@vo/core";
import { createApiClient } from "@vo/api-client";
import {
  officeServingThisPage,
  readApiConfig,
  type ApiConfig,
  type OfficeAddress,
} from "../api/config.js";

export type Session =
  | { readonly kind: "sample" }
  | {
      readonly kind: "signIn";
      readonly address: OfficeAddress;
      /** Null when nobody is simply signed in yet, which is not a problem. */
      readonly problem: string | null;
    }
  | {
      readonly kind: "choose";
      readonly address: OfficeAddress;
      /** Empty for a deployment nobody has made an office in yet. */
      readonly offices: readonly Office[];
    }
  | { readonly kind: "ready"; readonly config: ApiConfig };

export interface SessionDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly origin: string;
  /** Injected so the decisions can be tested without a server or a browser. */
  readonly probe?: (origin: string) => Promise<OfficeAddress | null>;
  readonly createClient?: (baseUrl: string) => ApiClient;
  /** The office this browser opened last time, which is an id and not a secret. */
  readonly remembered?: () => string | null;
}

/** A client with no token: the cookie the office set is the credential. */
const signedInClient = (baseUrl: string): ApiClient => createApiClient({ baseUrl });

export async function resolveSession(deps: SessionDeps): Promise<Session> {
  const configured = readApiConfig(deps.env);
  if (configured !== null) return { kind: "ready", config: configured };

  const probe = deps.probe ?? ((origin: string) => officeServingThisPage({ origin }));
  const address = await probe(deps.origin);
  if (address === null) return { kind: "sample" };

  const api = (deps.createClient ?? signedInClient)(address.baseUrl);
  const offices = await api.listOffices();

  if (!offices.ok) {
    // Not signed in is the ordinary first visit and says nothing; anything else
    // is worth repeating to whoever is looking at it.
    const problem =
      offices.kind === "unauthorized"
        ? null
        : offices.kind === "transport"
          ? offices.message
          : "the office would not say which offices it has";
    return { kind: "signIn", address, problem };
  }

  const remembered = (deps.remembered ?? (() => null))();
  const known = offices.value.find((one) => one.id === remembered);
  const only = offices.value.length === 1 ? offices.value[0] : undefined;
  const opening = known ?? only;
  if (opening === undefined) return { kind: "choose", address, offices: offices.value };

  return { kind: "ready", config: officeConfig(address, opening.id) };
}

/** The connection a canvas uses once it knows which office it is for. */
export function officeConfig(address: OfficeAddress, officeId: string): ApiConfig {
  return { baseUrl: address.baseUrl, streamUrl: address.streamUrl, officeId };
}
