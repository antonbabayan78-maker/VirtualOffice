import { describe, expect, it } from "vitest";
import {
  bearerToken,
  clearedSessionCookie,
  sessionCookie,
  sessionCookieHeader,
  tokenVerifier,
  SESSION_COOKIE,
} from "./auth.js";

describe("reading a bearer token", () => {
  it("takes the token out of an Authorization header", () => {
    expect(bearerToken("Bearer sk-test")).toBe("sk-test");
  });

  it("accepts the scheme in any case, since clients vary", () => {
    expect(bearerToken("bearer sk-test")).toBe("sk-test");
    expect(bearerToken("BEARER sk-test")).toBe("sk-test");
  });

  it("finds nothing in a header that is not a bearer token", () => {
    for (const header of [undefined, "", "sk-test", "Basic abc", "Bearer", "Bearer  "]) {
      expect(bearerToken(header), JSON.stringify(header)).toBeNull();
    }
  });
});

describe("verifying a token", () => {
  const verify = tokenVerifier({ "sk-owner": { ownerId: "owner-1" } });

  it("recognises a token it was given", () => {
    expect(verify("sk-owner")).toEqual({ ownerId: "owner-1" });
  });

  it("refuses one it was not", () => {
    expect(verify("sk-someone-else")).toBeNull();
  });

  it("refuses an empty token rather than matching an empty entry", () => {
    expect(tokenVerifier({ "": { ownerId: "nobody" } })("")).toBeNull();
  });

  it("compares the whole token, not a prefix of it", () => {
    expect(verify("sk-owner-and-more")).toBeNull();
    expect(verify("sk-own")).toBeNull();
  });
});

describe("reading a session cookie", () => {
  it("finds the office's own cookie among the others", () => {
    expect(sessionCookie(`a=1; ${SESSION_COOKIE}=sk-owner; b=2`)).toBe("sk-owner");
  });

  it("finds it when it is the only one", () => {
    expect(sessionCookie(`${SESSION_COOKIE}=sk-owner`)).toBe("sk-owner");
  });

  it("ignores the spaces browsers put between cookies", () => {
    expect(sessionCookie(`  ${SESSION_COOKIE}  =  sk-owner  ; b=2`)).toBe("sk-owner");
  });

  it("takes the value back out of its quotes", () => {
    // A cookie value with anything unusual in it comes back quoted.
    expect(sessionCookie(`${SESSION_COOKIE}="sk-owner"`)).toBe("sk-owner");
  });

  it("decodes a value the browser escaped", () => {
    expect(sessionCookie(`${SESSION_COOKIE}=sk%2Fowner`)).toBe("sk/owner");
  });

  it("finds nothing when there is no such cookie", () => {
    for (const header of [undefined, "", "other=1", `${SESSION_COOKIE}x=sk-owner`]) {
      expect(sessionCookie(header), JSON.stringify(header)).toBeNull();
    }
  });

  it("finds nothing in an empty one, rather than an empty token", () => {
    expect(sessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
  });

  it("does not match a cookie whose name merely ends with this one", () => {
    expect(sessionCookie(`not_${SESSION_COOKIE}=sk-owner`)).toBeNull();
  });
});

describe("the cookie the office sets", () => {
  it("cannot be read by script on the page, which is the whole point", () => {
    expect(sessionCookieHeader("sk-owner", { secure: false })).toMatch(/HttpOnly/i);
  });

  it("is not sent by anybody else's page, which is what stands in for a CSRF token", () => {
    expect(sessionCookieHeader("sk-owner", { secure: false })).toMatch(/SameSite=Strict/i);
  });

  it("covers the whole office, not the path that happened to set it", () => {
    expect(sessionCookieHeader("sk-owner", { secure: false })).toMatch(/Path=\//);
  });

  it("outlives the browser window", () => {
    expect(sessionCookieHeader("sk-owner", { secure: false })).toMatch(/Max-Age=\d{5,}/);
  });

  it("is marked secure when the office is reached over https", () => {
    expect(sessionCookieHeader("sk-owner", { secure: true })).toMatch(/Secure/);
  });

  it("is not marked secure on plain http, or the browser would drop it", () => {
    // Which would make signing in appear to work and then never be there — the
    // whole kit runs on http://localhost before it runs anywhere else.
    expect(sessionCookieHeader("sk-owner", { secure: false })).not.toMatch(/Secure/);
  });

  it("escapes the token, since it is whatever somebody configured", () => {
    expect(sessionCookieHeader("sk/owner value", { secure: false })).toContain(
      "sk%2Fowner%20value",
    );
  });

  it("clears it by asking for a cookie that has already expired", () => {
    const cleared = clearedSessionCookie();
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(cleared).toMatch(/HttpOnly/i);
  });
});
