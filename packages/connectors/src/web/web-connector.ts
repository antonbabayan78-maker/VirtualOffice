/**
 * Reading a page, the way an employee would.
 *
 * GET only, and deliberately so. Fetching a page the office itself named is
 * none of the categories an office gates — it spends nothing, sends nothing and
 * changes nothing outside. The allowlist is the control here, and a human gate
 * would have nothing to hold. The moment a tool can post, send or deploy, the
 * pre-execution gate is what stops it, and that belongs with the first such
 * tool rather than here.
 *
 * What comes back is text, not HTML. A document the office keeps as HTML is
 * read back into the next prompt as HTML and spends the whole budget on tags.
 * The conversion is crude on purpose: this is a page an agent is reading, not a
 * document being published.
 *
 * `fetch` is injected, as the API client's is, so every test of this is offline.
 */
import type { BrokerCall, BrokerOutcome, DescribedTool, ToolBroker } from "@vo/orchestrator";
import { isAllowed, parseAllowlist } from "./allowlist.js";

export type WebFetch = (url: string, init: RequestInit) => Promise<Response>;

export const WEB_TOOLS = ["fetch_url"] as const;

/** Bigger than a page worth reading, smaller than one that hurts. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
/** What the model is told. The rest is in the document. */
export const EXCERPT_CHARS = 2_000;
export const MAX_REDIRECTS = 5;

export interface WebConnectorOptions {
  readonly connectorId: string;
  /** The connector's name, which is the prefix on its tool names. */
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly fetch?: WebFetch;
}

/**
 * HTML to something worth reading.
 *
 * Scripts and styles go first — their contents are not the page. Then block
 * elements become line breaks so the text does not run together, tags go, and
 * the handful of entities that actually appear in prose are turned back.
 */
export function readableText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A file name for a page, so a tray reads as a list of things rather than urls. */
export function documentNameFor(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "page.md";
  }
  const last = parsed.pathname.split("/").filter(Boolean).pop();
  // A page's own extension goes; a host's does not — acme.test is the name,
  // and "acme.md" would be a document nobody could place.
  const stem = last === undefined ? parsed.hostname : last.replace(/\.[a-z0-9]+$/i, "");
  const safe = stem.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  return `${safe.length === 0 ? "page" : safe}.md`;
}

const said = (summary: string): BrokerOutcome => ({ summary });

export function webBroker(options: WebConnectorOptions): ToolBroker {
  const policy = parseAllowlist(options.config);
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  const described: DescribedTool[] = [
    {
      connectorId: options.connectorId,
      name: "fetch_url",
      description:
        "Read a web page. Fetches the address and files what it says in this work's in-tray," +
        " returning the opening of it. Reads only: it cannot submit a form or send anything.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The address to read, including https://." },
        },
        required: ["url"],
      },
    },
  ];

  /** Follows redirects by hand, because every hop has to be checked again. */
  const fetchChecked = async (from: string): Promise<Response | string> => {
    let url = from;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const verdict = isAllowed(url, policy);
      if (!verdict.allowed) {
        return hop === 0
          ? `Did not read ${url}: ${verdict.reason}`
          : `${from} redirected to ${url}, which was not read: ${verdict.reason}`;
      }

      const response = await doFetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status < 300 || response.status >= 400) return response;

      const location = response.headers.get("location");
      if (location === null) return response;
      url = new URL(location, url).toString();
    }
    return `${from} redirected more times than this office follows.`;
  };

  return {
    describe: () => Promise.resolve(described),

    async call(call: BrokerCall): Promise<BrokerOutcome> {
      const tool = call.name.split("__").slice(1).join("__");
      if (tool !== "fetch_url") {
        return Promise.reject(new Error(`this connector has no tool "${tool}"`));
      }

      const url = call.input["url"];
      if (typeof url !== "string" || url.length === 0) {
        return said("That call named no url to read.");
      }

      let response: Response | string;
      try {
        response = await fetchChecked(url);
      } catch (error) {
        return said(
          `Could not read ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof response === "string") return said(response);

      if (!response.ok) {
        return said(`${url} answered ${String(response.status)}, so there is nothing to read.`);
      }

      const body = await response.text();
      if (body.length > MAX_PAGE_BYTES) {
        return said(`${url} is larger than this office reads in one go.`);
      }

      const type = response.headers.get("content-type") ?? "";
      const text = type.includes("html") ? readableText(body) : body.trim();
      const name = documentNameFor(url);

      return {
        summary:
          `Read ${url} (${String(text.length)} characters). It begins:\n` +
          text.slice(0, EXCERPT_CHARS),
        artifact: { name, mediaType: "text/markdown", content: text },
      };
    },
  };
}
