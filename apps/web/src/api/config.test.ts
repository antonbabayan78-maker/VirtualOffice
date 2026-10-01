import { describe, expect, it } from "vitest";
import { officeServingThisPage, readApiConfig } from "./config.js";

describe("deciding whether there is an office to talk to", () => {
  it("is configured when it has a url, a token and an office", () => {
    const config = readApiConfig({
      VITE_VO_API_URL: "http://localhost:3000",
      VITE_VO_API_TOKEN: "sk-owner",
      VITE_VO_OFFICE_ID: "office-1",
    });
    expect(config).toEqual({
      baseUrl: "http://localhost:3000",
      token: "sk-owner",
      officeId: "office-1",
      streamUrl: "ws://localhost:3000/ws",
    });
  });

  it("is not configured when any of the three is missing", () => {
    const full = {
      VITE_VO_API_URL: "http://localhost:3000",
      VITE_VO_API_TOKEN: "sk-owner",
      VITE_VO_OFFICE_ID: "office-1",
    };
    for (const missing of Object.keys(full)) {
      const partial = { ...full, [missing]: undefined };
      expect(readApiConfig(partial), missing).toBeNull();
    }
  });

  it("treats an empty setting as no setting, since that is what a blank .env gives", () => {
    expect(
      readApiConfig({
        VITE_VO_API_URL: "",
        VITE_VO_API_TOKEN: "sk-owner",
        VITE_VO_OFFICE_ID: "office-1",
      }),
    ).toBeNull();
  });

  it("drops a trailing slash, so paths do not end up doubled", () => {
    const config = readApiConfig({
      VITE_VO_API_URL: "http://localhost:3000/",
      VITE_VO_API_TOKEN: "sk-owner",
      VITE_VO_OFFICE_ID: "office-1",
    });
    expect(config?.baseUrl).toBe("http://localhost:3000");
  });

  it("works out where the stream lives from where the API lives", () => {
    expect(
      readApiConfig({
        VITE_VO_API_URL: "http://localhost:3000",
        VITE_VO_API_TOKEN: "t",
        VITE_VO_OFFICE_ID: "o",
      })?.streamUrl,
    ).toBe("ws://localhost:3000/ws");

    expect(
      readApiConfig({
        VITE_VO_API_URL: "https://office.example.com",
        VITE_VO_API_TOKEN: "t",
        VITE_VO_OFFICE_ID: "o",
      })?.streamUrl,
    ).toBe("wss://office.example.com/ws");
  });
});

describe("an office that served this page", () => {
  const ok = () =>
    Promise.resolve(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  it("asks its own address whether an office answers there", async () => {
    const asked: string[] = [];
    const where = await officeServingThisPage({
      origin: "https://office.example.com",
      fetch: (input) => {
        asked.push(input instanceof Request ? input.url : input.toString());
        return ok();
      },
    });

    expect(asked).toEqual(["https://office.example.com/health"]);
    expect(where).toEqual({
      baseUrl: "https://office.example.com",
      streamUrl: "wss://office.example.com/ws",
    });
  });

  it("finds none when the address answers something that is not an office", async () => {
    // A dev server answers every path with the canvas itself, and HTML is not
    // an office saying it is well.
    const html = () =>
      Promise.resolve(
        new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
      );
    const where = await officeServingThisPage({
      origin: "http://localhost:5173",
      fetch: html,
    });

    expect(where).toBeNull();
  });

  it("finds none when nothing answers at all", async () => {
    const where = await officeServingThisPage({
      origin: "http://localhost:5173",
      fetch: () => Promise.reject(new Error("refused")),
    });
    expect(where).toBeNull();
  });

  it("finds none when the address answers an error", async () => {
    const where = await officeServingThisPage({
      origin: "http://localhost:5173",
      fetch: () => Promise.resolve(new Response("nope", { status: 502 })),
    });
    expect(where).toBeNull();
  });
});
