import { describe, expect, it } from "vitest";
import { bearerToken, tokenVerifier } from "./auth.js";

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
