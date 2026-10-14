import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveDashboardConnection } from "../src/dashboard-config.js";
describe("dashboard connection configuration", () => {
  it("uses the private URL only for server-to-server connections", () => {
    expect(
      resolveDashboardConnection({
        NODE_ENV: "production",
        APP_URL: "https://monarch.example.com/",
        DASHBOARD_INTERNAL_URL: "http://dashboard:3000/",
        INTERNAL_API_TOKEN: randomBytes(32).toString("hex"),
      }),
    ).toMatchObject({
      appUrl: "https://monarch.example.com",
      dashboardInternalUrl: "http://dashboard:3000",
    });
  });
  it("defaults private URL to the public dashboard for separate workers", () => {
    expect(
      resolveDashboardConnection({ APP_URL: "https://monarch.example.com" }).dashboardInternalUrl,
    ).toBe("https://monarch.example.com");
  });
  it("retains local development defaults", () => {
    expect(resolveDashboardConnection({ NODE_ENV: "development" }).appUrl).toBe(
      "http://localhost:3000",
    );
  });
  it.each([
    {},
    { APP_URL: "http://host" },
    { APP_URL: "https://host/path" },
    { APP_URL: "https://user:pass@host" },
    { APP_URL: "https://host", DASHBOARD_INTERNAL_URL: "invalid" },
    { APP_URL: "https://host", INTERNAL_API_TOKEN: "dev-only-secret-change-me" },
  ])("rejects invalid production configuration", (input) => {
    expect(() => resolveDashboardConnection({ NODE_ENV: "production", ...input })).toThrow();
  });
});
