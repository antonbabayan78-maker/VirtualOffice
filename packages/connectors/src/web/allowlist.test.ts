import { describe, expect, it } from "vitest";
import { isAllowed, parseAllowlist, type WebPolicy } from "./allowlist.js";

const policy = (hosts: string[], overrides: Partial<WebPolicy> = {}): WebPolicy => ({
  hosts,
  allowPlainHttp: false,
  ...overrides,
});

const allows = (url: string, hosts = ["acme.test"], overrides: Partial<WebPolicy> = {}): boolean =>
  isAllowed(url, policy(hosts, overrides)).allowed;

const why = (url: string, hosts = ["acme.test"]): string => {
  const verdict = isAllowed(url, policy(hosts));
  return verdict.allowed ? "" : verdict.reason;
};

describe("a host the office named", () => {
  it("lets through exactly that host", () => {
    expect(allows("https://acme.test/pricing")).toBe(true);
  });

  it("does not let through a subdomain of it", () => {
    // Naming a host means that host. A wildcard is how you say otherwise.
    expect(allows("https://mail.acme.test/")).toBe(false);
  });

  it("lets a wildcard through for a subdomain", () => {
    expect(allows("https://mail.acme.test/", ["*.acme.test"])).toBe(true);
  });

  it("lets a wildcard through for a deeper subdomain", () => {
    expect(allows("https://a.b.acme.test/", ["*.acme.test"])).toBe(true);
  });

  it("does not let a wildcard cover the bare host it wildcards", () => {
    expect(allows("https://acme.test/", ["*.acme.test"])).toBe(false);
  });

  it("refuses a host that merely ends the same way", () => {
    // The whole reason this does not use endsWith.
    expect(allows("https://evil-acme.test/")).toBe(false);
    expect(allows("https://notacme.test/", ["*.acme.test"])).toBe(false);
  });

  it("ignores case and a trailing dot, which are the same host", () => {
    expect(allows("https://ACME.test/")).toBe(true);
    expect(allows("https://acme.test./")).toBe(true);
  });

  it("refuses everything when the office named no hosts", () => {
    expect(allows("https://acme.test/", [])).toBe(false);
  });
});

describe("hosts that are not really hosts", () => {
  it("refuses a host smuggled in as a username", () => {
    // https://acme.test@evil.test/ is a request to evil.test.
    expect(allows("https://acme.test@evil.test/")).toBe(false);
  });

  it("refuses a host that only appears in the query", () => {
    expect(allows("https://evil.test/?ref=acme.test")).toBe(false);
  });

  it("refuses a host that only appears in the path", () => {
    expect(allows("https://evil.test/acme.test/pricing")).toBe(false);
  });

  it("refuses a host that only appears in the fragment", () => {
    expect(allows("https://evil.test/#acme.test")).toBe(false);
  });
});

describe("schemes", () => {
  it("allows https", () => {
    expect(allows("https://acme.test/")).toBe(true);
  });

  it("refuses plain http unless the office said so", () => {
    expect(allows("http://acme.test/")).toBe(false);
    expect(allows("http://acme.test/", ["acme.test"], { allowPlainHttp: true })).toBe(true);
  });

  it("refuses a scheme that reaches something other than the web", () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "ftp://acme.test/x",
      "javascript:alert(1)",
    ]) {
      expect(allows(url), url).toBe(false);
    }
  });

  it("refuses something that is not a URL at all", () => {
    expect(allows("acme.test/pricing")).toBe(false);
    expect(allows("   ")).toBe(false);
  });
});

describe("addresses inside the building", () => {
  const refusedEvenWhenNamed = (host: string) => {
    // Named or not: an office that allowlists its own metadata service has
    // made a mistake, and the answer is to refuse rather than to obey.
    expect(allows(`https://${host}/`, [host])).toBe(false);
  };

  it("refuses loopback", () => {
    refusedEvenWhenNamed("127.0.0.1");
    refusedEvenWhenNamed("localhost");
    expect(allows("https://[::1]/", ["[::1]"])).toBe(false);
  });

  it("refuses the cloud metadata address", () => {
    refusedEvenWhenNamed("169.254.169.254");
  });

  it("refuses private ranges", () => {
    for (const host of ["10.0.0.5", "172.16.3.4", "192.168.1.1", "0.0.0.0"]) {
      refusedEvenWhenNamed(host);
    }
  });

  it("refuses names that only resolve inside", () => {
    refusedEvenWhenNamed("db.internal");
    refusedEvenWhenNamed("api.localhost");
  });

  it("still allows an ordinary public address", () => {
    expect(allows("https://93.184.216.34/", ["93.184.216.34"])).toBe(true);
  });

  it("says why, so the trail reads", () => {
    expect(why("https://127.0.0.1/")).toMatch(/inside/i);
    expect(why("https://elsewhere.test/")).toMatch(/does not allow/i);
    expect(why("file:///etc/passwd")).toMatch(/scheme|https/i);
  });
});

describe("reading an allowlist out of a connector's configuration", () => {
  it("takes the hosts it was given", () => {
    expect(parseAllowlist({ hosts: ["acme.test", "*.figma.com"] }).hosts).toEqual([
      "acme.test",
      "*.figma.com",
    ]);
  });

  it("allows nothing when the configuration says nothing", () => {
    // A web connector with no allowlist reaches nowhere, rather than everywhere.
    expect(parseAllowlist({}).hosts).toEqual([]);
    expect(parseAllowlist({ hosts: "acme.test" }).hosts).toEqual([]);
  });

  it("ignores entries that are not hosts", () => {
    expect(parseAllowlist({ hosts: ["acme.test", 7, ""] }).hosts).toEqual(["acme.test"]);
  });

  it("keeps plain http off unless it is asked for", () => {
    expect(parseAllowlist({ hosts: [] }).allowPlainHttp).toBe(false);
    expect(parseAllowlist({ hosts: [], allowPlainHttp: true }).allowPlainHttp).toBe(true);
  });
});
