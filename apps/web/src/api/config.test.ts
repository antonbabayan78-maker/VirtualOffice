import { describe, expect, it } from "vitest";
import { readApiConfig } from "./config.js";

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
