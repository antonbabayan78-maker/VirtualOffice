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
  readonly token: string;
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
