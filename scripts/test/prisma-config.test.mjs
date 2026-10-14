import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllEnvs());
describe("Prisma 7 CLI datasource", () => {
  it("uses DIRECT_DATABASE_URL as the CLI datasource, not an unsupported directUrl key", async () => {
    vi.stubEnv("DIRECT_DATABASE_URL", "postgresql://direct.example/monarch");
    vi.stubEnv("DATABASE_URL", "postgresql://pooled.example/monarch");
    vi.resetModules();
    const { default: config } = await import("../../prisma.config.ts");
    expect(config.datasource.url).toBe("postgresql://direct.example/monarch");
    expect(config.datasource).not.toHaveProperty("directUrl");
  });
  it("falls back to DATABASE_URL for plain PostgreSQL", async () => {
    vi.stubEnv("DIRECT_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/monarch");
    vi.resetModules();
    const { default: config } = await import("../../prisma.config.ts");
    expect(config.datasource.url).toBe("postgresql://localhost/monarch");
  });
});
