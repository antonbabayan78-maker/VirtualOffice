import { describe, expect, it } from "vitest";
import { webBroker, WEB_TOOLS, type WebFetch } from "./web-connector.js";

const connectorId = "conn-web";
const page = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });

/** A fetch that answers from a table, and records what it was asked. */
function scripted(pages: Record<string, Response>): { fetch: WebFetch; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: (url) => {
      asked.push(url);
      const answer = pages[url];
      if (answer === undefined) return Promise.reject(new Error(`nothing scripted for ${url}`));
      return Promise.resolve(answer.clone());
    },
  };
}

const broker = (pages: Record<string, Response>, hosts = ["acme.test"]) => {
  const { fetch, asked } = scripted(pages);
  return {
    asked,
    broker: webBroker({
      connectorId,
      name: "web",
      config: { hosts },
      fetch,
    }),
  };
};

const fetchUrl = (url: string) => ({ name: "web__fetch_url", input: { url } });

describe("what a web connector says it can do", () => {
  it("offers one tool, which fetches a page", async () => {
    const { broker: b } = broker({});
    const described = await b.describe();

    expect(described.map((tool) => tool.name)).toEqual([...WEB_TOOLS]);
    expect(described[0]?.connectorId).toBe(connectorId);
  });

  it("says in its description that it only reads", async () => {
    const { broker: b } = broker({});
    expect((await b.describe())[0]?.description).toMatch(/read|fetch/i);
  });
});

describe("fetching a page", () => {
  it("brings back the text of an allowed page", async () => {
    const { broker: b } = broker({
      "https://acme.test/pricing": page("<h1>Pricing</h1><p>From $9.</p>"),
    });

    const outcome = await b.call(fetchUrl("https://acme.test/pricing"));
    expect(outcome.artifact?.content).toContain("Pricing");
    expect(outcome.artifact?.content).toContain("From $9.");
  });

  it("files it as markdown, not as the HTML it arrived in", async () => {
    // A document the office keeps as HTML comes back into the next prompt as
    // HTML, and spends the budget on tags.
    const { broker: b } = broker({
      "https://acme.test/pricing": page("<h1>Pricing</h1>"),
    });

    const outcome = await b.call(fetchUrl("https://acme.test/pricing"));
    expect(outcome.artifact?.mediaType).toBe("text/markdown");
    expect(outcome.artifact?.content).not.toContain("<h1>");
  });

  it("names the document after the page, so a tray reads", async () => {
    const { broker: b } = broker({ "https://acme.test/pricing": page("<p>x</p>") });
    expect((await b.call(fetchUrl("https://acme.test/pricing"))).artifact?.name).toBe("pricing.md");
  });

  it("names a document for a page that is just a host", async () => {
    const { broker: b } = broker({ "https://acme.test/": page("<p>x</p>") });
    expect((await b.call(fetchUrl("https://acme.test/"))).artifact?.name).toBe("acme.test.md");
  });

  it("tells the model what it got, briefly", async () => {
    const { broker: b } = broker({ "https://acme.test/pricing": page("<p>x</p>") });
    const outcome = await b.call(fetchUrl("https://acme.test/pricing"));

    expect(outcome.summary).toContain("acme.test/pricing");
  });

  it("gives the model an excerpt, not the whole page", async () => {
    // The summary goes into every later request; the document holds the rest.
    const long = `<p>${"word ".repeat(4000)}</p>`;
    const { broker: b } = broker({ "https://acme.test/long": page(long) });
    const outcome = await b.call(fetchUrl("https://acme.test/long"));

    expect(outcome.summary.length).toBeLessThan(3000);
    expect((outcome.artifact?.content.length ?? 0) > outcome.summary.length).toBe(true);
  });

  it("takes plain text as it comes", async () => {
    const { broker: b } = broker({
      "https://acme.test/robots.txt": new Response("User-agent: *", {
        headers: { "content-type": "text/plain" },
      }),
    });
    expect((await b.call(fetchUrl("https://acme.test/robots.txt"))).artifact?.content).toContain(
      "User-agent",
    );
  });
});

describe("pages it will not fetch", () => {
  it("refuses a host the office did not name, without asking for it", async () => {
    const { broker: b, asked } = broker({});
    const outcome = await b.call(fetchUrl("https://elsewhere.test/"));

    expect(outcome.summary).toMatch(/does not allow/i);
    expect(outcome.artifact).toBeUndefined();
    // Not requested at all: a refused fetch must not be a request that happened.
    expect(asked).toEqual([]);
  });

  it("refuses an address inside the building", async () => {
    const { broker: b, asked } = broker({}, ["169.254.169.254"]);
    const outcome = await b.call(fetchUrl("https://169.254.169.254/latest/meta-data/"));

    expect(outcome.summary).toMatch(/inside/i);
    expect(asked).toEqual([]);
  });

  it("says what it was asked for when there is no url at all", async () => {
    const { broker: b } = broker({});
    expect((await b.call({ name: "web__fetch_url", input: {} })).summary).toMatch(/url/i);
  });

  it("does not answer a tool it does not have", async () => {
    const { broker: b } = broker({});
    await expect(b.call({ name: "web__post_form", input: {} })).rejects.toThrow(/post_form/);
  });

  it("says a page did not answer rather than pretending it did", async () => {
    const { broker: b } = broker({});
    const outcome = await b.call(fetchUrl("https://acme.test/gone"));
    expect(outcome.summary).toMatch(/could not|nothing scripted/i);
    expect(outcome.artifact).toBeUndefined();
  });

  it("says so when the page answers with an error", async () => {
    const { broker: b } = broker({
      "https://acme.test/missing": new Response("nope", { status: 404 }),
    });
    const outcome = await b.call(fetchUrl("https://acme.test/missing"));

    expect(outcome.summary).toContain("404");
    expect(outcome.artifact).toBeUndefined();
  });
});

describe("a page that points somewhere else", () => {
  const redirect = (to: string): Response =>
    new Response(null, { status: 302, headers: { location: to } });

  it("follows a redirect within the allowlist", async () => {
    const { broker: b, asked } = broker({
      "https://acme.test/old": redirect("https://acme.test/new"),
      "https://acme.test/new": page("<p>Here</p>"),
    });

    const outcome = await b.call(fetchUrl("https://acme.test/old"));
    expect(outcome.artifact?.content).toContain("Here");
    expect(asked).toEqual(["https://acme.test/old", "https://acme.test/new"]);
  });

  it("resolves a relative redirect against where it came from", async () => {
    const { broker: b, asked } = broker({
      "https://acme.test/old": redirect("/new"),
      "https://acme.test/new": page("<p>Here</p>"),
    });

    await b.call(fetchUrl("https://acme.test/old"));
    expect(asked[1]).toBe("https://acme.test/new");
  });

  it("stops at a redirect that leaves the allowlist, and says which", async () => {
    // The whole point of re-checking every hop: an allowed host can send you
    // anywhere, and "fetch failed" would not explain what happened.
    const { broker: b, asked } = broker({
      "https://acme.test/out": redirect("https://evil.test/"),
    });

    const outcome = await b.call(fetchUrl("https://acme.test/out"));
    expect(outcome.summary).toMatch(/redirect/i);
    expect(outcome.summary).toContain("evil.test");
    expect(outcome.artifact).toBeUndefined();
    expect(asked).toEqual(["https://acme.test/out"]);
  });

  it("gives up rather than following a loop forever", async () => {
    const { broker: b, asked } = broker({
      "https://acme.test/a": redirect("https://acme.test/a"),
    });

    const outcome = await b.call(fetchUrl("https://acme.test/a"));
    expect(outcome.summary).toMatch(/redirect/i);
    expect(asked.length).toBeLessThanOrEqual(6);
  });
});
