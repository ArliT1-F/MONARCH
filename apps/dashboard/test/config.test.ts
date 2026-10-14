import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { resolveConfig, secretStrength, type ConfigInput } from "@/lib/config";
const production = (): ConfigInput => ({
  NODE_ENV: "production",
  SESSION_SECRET: randomBytes(32).toString("hex"),
  APP_URL: "https://monarch.example.com",
  DATABASE_URL: "postgresql://localhost/monarch",
  DISCORD_CLIENT_ID: "123",
  DISCORD_CLIENT_SECRET: "test-secret",
  DISCORD_BOT_TOKEN: "test-token",
});
describe("runtime configuration", () => {
  it("accepts a complete production environment without revealing secrets", () => {
    const input = production();
    expect(resolveConfig(input).errors).toEqual([]);
    expect(JSON.stringify(resolveConfig(input).issues)).not.toContain(input.SESSION_SECRET);
  });
  it.each([undefined, "", "dev-only-secret-change-me", "a".repeat(64), "short"])(
    "rejects weak production signing secrets (%s)",
    (value) => {
      expect(
        resolveConfig({ ...production(), SESSION_SECRET: value }).errors.some(
          (i) => i.variable === "SESSION_SECRET",
        ),
      ).toBe(true);
    },
  );
  it("never enables demo because a production credential is absent", () => {
    const config = resolveConfig({ ...production(), DISCORD_CLIENT_SECRET: "" });
    expect(config.demoMode).toBe(false);
    expect(config.errors.some((i) => i.code === "discord.credentials-missing")).toBe(true);
  });
  it("forbids explicit production demo mode and file-store bypass", () => {
    const config = resolveConfig({ ...production(), MONARCH_DEMO: "1", DATABASE_URL: "" });
    expect(config.demoMode).toBe(false);
    expect(config.errors.map((i) => i.code)).toContain("demo-mode.production");
    expect(config.errors.map((i) => i.code)).toContain("database-url.missing");
  });
  it("requires explicit development demo mode", () => {
    expect(resolveConfig({ NODE_ENV: "development" }).demoMode).toBe(false);
    const demo = resolveConfig({ NODE_ENV: "development", MONARCH_DEMO: "1" });
    expect(demo.errors).toEqual([]);
    expect(demo.storageMode).toBe("file");
    expect(demo.demoMode).toBe(true);
  });
  it.each(["https://host/database", "not a URL"])("rejects malformed DB URLs", (DATABASE_URL) => {
    expect(resolveConfig({ ...production(), DATABASE_URL }).errors.map((i) => i.code)).toContain(
      "database-url.malformed",
    );
  });
  it.each([
    undefined,
    "http://monarch.example.com",
    "https://user:pass@host",
    "https://host/subpath",
    "https://host/?query=yes",
  ])("rejects invalid production public URLs", (APP_URL) => {
    expect(resolveConfig({ ...production(), APP_URL }).errors.map((i) => i.code)).toContain(
      "app-url.invalid",
    );
  });
  it("disables missing/weak internal tokens but preserves short local test tokens", () => {
    for (const token of [undefined, "dev-only-secret-change-me", "a".repeat(64), "short"]) {
      expect(
        resolveConfig({ ...production(), INTERNAL_API_TOKEN: token }).internalApiToken,
      ).toBeNull();
    }
    expect(
      resolveConfig({ NODE_ENV: "test", INTERNAL_API_TOKEN: "test-internal-token" })
        .internalApiToken,
    ).toBe("test-internal-token");
  });
  it("requires a database on serverless even in development", () => {
    expect(
      resolveConfig({ NODE_ENV: "development", MONARCH_DEMO: "1", VERCEL: "1" }).errors.map(
        (i) => i.code,
      ),
    ).toContain("database-url.missing");
  });
  it("treats unknown environments as production", () => {
    expect(resolveConfig({ NODE_ENV: "staging" }).isProduction).toBe(true);
  });
  it("rejects published placeholders even with padding", () => {
    expect(secretStrength("change-me".padEnd(64, "x")).ok).toBe(false);
  });
});

describe("Next startup validation", () => {
  it("rejects production startup configuration without requiring secrets during build", async () => {
    const { default: configuration } = await import("../next.config");
    const { PHASE_PRODUCTION_SERVER, PHASE_PRODUCTION_BUILD } = await import("next/constants");
    const saved = process.env;
    try {
      process.env = { NODE_ENV: "production" };
      expect(() => configuration(PHASE_PRODUCTION_SERVER)).toThrow("SESSION_SECRET");
      expect(() => configuration(PHASE_PRODUCTION_BUILD)).not.toThrow();
    } finally { process.env = saved; }
  });
});
