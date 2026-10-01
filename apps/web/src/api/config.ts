/**
 * Whether this canvas has an office to talk to.
 *
 * All three settings or none: a url without a token is not half-configured, it
 * is misconfigured, and a canvas that tries anyway just fails on every request.
 * With none of them the canvas runs on its own, which is what makes the app
 * usable before a server is running.
 */
export interface ApiConfig {
  readonly baseUrl: string;
  /**
   * What a canvas somebody configured carries. A canvas the office served has
   * none: it signed in, and the office set a cookie the page cannot read.
   */
  readonly token?: string;
  readonly officeId: string;
  /** Where the event stream lives, worked out from the API's own address. */
  readonly streamUrl: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const setting = (env: Env, key: string): string | null => {
  const value = env[key];
  return value === undefined || value.trim().length === 0 ? null : value.trim();
};

export function readApiConfig(env: Env): ApiConfig | null {
  const rawUrl = setting(env, "VITE_VO_API_URL");
  const token = setting(env, "VITE_VO_API_TOKEN");
  const officeId = setting(env, "VITE_VO_OFFICE_ID");
  if (rawUrl === null || token === null || officeId === null) return null;

  const baseUrl = rawUrl.replace(/\/+$/, "");
  const streamUrl = `${baseUrl.replace(/^http/, "ws")}/ws`;
  return { baseUrl, token, officeId, streamUrl };
}

/** Where an office is, with no credential: the browser signs in for that. */
export interface OfficeAddress {
  readonly baseUrl: string;
  readonly streamUrl: string;
}

export interface ProbeOptions {
  /** This page's own address, which is where a served canvas looks first. */
  readonly origin: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Whether an office served this page.
 *
 * Asked rather than assumed, because the same bundle runs two ways: served by
 * an office, where there is nothing to configure and the browser signs in, and
 * on a dev server, where `VITE_VO_API_URL` names an office somewhere else and a
 * token comes with it.
 *
 * It asks for `/health` and insists on an office's own answer. A dev server
 * replies to every path with the canvas itself, and "200 OK" is not an office
 * saying it is well — only `{"status":"ok"}` is.
 */
export async function officeServingThisPage(options: ProbeOptions): Promise<OfficeAddress | null> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = options.origin.replace(/\/+$/, "");
  try {
    const response = await doFetch(`${baseUrl}/health`);
    if (!response.ok) return null;
    const body = (await response.json()) as { status?: unknown };
    if (body.status !== "ok") return null;
    return { baseUrl, streamUrl: `${baseUrl.replace(/^http/, "ws")}/ws` };
  } catch {
    // Nothing there, or something there that does not speak JSON. Either way
    // this page was not served by an office.
    return null;
  }
}
