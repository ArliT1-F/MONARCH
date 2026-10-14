import { describe, expect, it } from "vitest";
import { isPlaceholder, mask, scanText } from "../scan-secrets.mjs";

/**
 * Secret-scanner tests.
 *
 * Every credential-shaped literal below is assembled at runtime from parts
 * (`"npg_" + "…"`) so this test file never contains a value that looks like a
 * real committed secret — and never trips the scanner it is testing.
 */

const NEON = `npg_${"Ab1Cd2Ef3Gh4"}`;
const PG_URL = `postgresql://neondb_owner:${NEON}@ep-example-pooler.region.aws.neon.tech/neondb`;
const DISCORD_TOKEN = `M${"x".repeat(23)}.${"y".repeat(6)}.${"z".repeat(27)}`;
const GH_TOKEN = `ghp_${"A1".repeat(18)}`;
const AWS_KEY = `AKIA${"A1".repeat(8)}`;
const JWT = `eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)}.${"c".repeat(10)}`;

function rules(text) {
  return scanText(text).map((f) => f.rule);
}

describe("secret scanner — detection (positive controls)", () => {
  it("catches the Neon role password shape that was committed to .env.example", () => {
    expect(rules(`DATABASE_URL=${PG_URL}`)).toContain("neon-role-password");
    expect(rules(`DATABASE_URL=${PG_URL}`)).toContain("db-url-with-password");
  });

  it("catches a bare Neon password with no URL around it", () => {
    expect(rules(`password: ${NEON}`)).toContain("neon-role-password");
  });

  it("catches platform tokens and keys", () => {
    expect(rules(`DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`)).toContain("discord-bot-token");
    expect(rules(`GITHUB_TOKEN=${GH_TOKEN}`)).toContain("github-token");
    expect(rules(`aws_access_key_id = ${AWS_KEY}`)).toContain("aws-access-key-id");
    expect(rules(`const t = "${JWT}"`)).toContain("jwt");
  });

  it("catches PEM private key blocks", () => {
    expect(rules("-----BEGIN RSA " + "PRIVATE KEY-----")).toContain("private-key-block");
    expect(rules("-----BEGIN OPENSSH " + "PRIVATE KEY-----")).toContain("private-key-block");
  });

  it("catches a secret assigned to a credential-named variable", () => {
    expect(rules(`SESSION_SECRET=${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"}`)).toContain(
      "secret-assignment",
    );
    expect(rules(`INTERNAL_API_TOKEN: "${"9f8e7d6c5b4a39281706f5e4d3c2b1a0"}"`)).toContain(
      "secret-assignment",
    );
  });

  it("catches a hard-coded Authorization: Bearer credential", () => {
    expect(
      rules(`headers = { "Authorization": "Bearer ${"abc123def456ghi789jkl012mno"}" }`),
    ).toContain("authorization-bearer-literal");
  });

  it("scans YAML, JSON and shell shapes, not just KEY=VALUE", () => {
    expect(rules(`      SESSION_SECRET: "${"Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6"}"`)).toContain(
      "secret-assignment",
    );
    expect(rules(`export APP_SECRET='${"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4"}'`)).toContain(
      "secret-assignment",
    );
  });
});

describe("secret scanner — no false positives on this repository's own patterns", () => {
  it("accepts empty, placeholder and interpolated values", () => {
    expect(rules("SESSION_SECRET=")).toEqual([]);
    expect(rules("INTERNAL_API_TOKEN=")).toEqual([]);
    expect(rules("SESSION_SECRET=dev-only-secret-change-me")).toEqual([]);
    expect(rules("DATABASE_URL=postgresql://<user>:<password>@host/db")).toEqual([]);
    expect(
      rules(
        "DATABASE_URL: postgresql://monarch:${POSTGRES_PASSWORD:-monarch}@postgres:5432/monarch",
      ),
    ).toEqual([]);
    expect(rules("DATABASE_URL=process.env.DATABASE_URL")).toEqual([]);
    expect(rules("const token = process.env.INTERNAL_API_TOKEN;")).toEqual([]);
  });

  it("accepts documented local-development defaults", () => {
    expect(rules("#   DATABASE_URL=postgresql://monarch:monarch@localhost:5432/monarch")).toEqual(
      [],
    );
    expect(
      rules("connectionString = `postgresql://postgres:postgres@${hostPort}/postgres`;"),
    ).toEqual([]);
  });

  it("accepts test fixtures", () => {
    expect(rules('INTERNAL_API_TOKEN: "test-internal-token"')).toEqual([]);
    expect(rules('const key = "mock_api_key_value_here"')).toEqual([]);
    expect(rules('token = "dummy-token-for-tests"')).toEqual([]);
  });

  it("accepts a redaction written for documentation", () => {
    expect(
      rules(
        "DATABASE_URL=postgresql://neondb_owner:<REDACTED-PASSWORD>@ep-<REDACTED>-pooler.region.aws.neon.tech/neondb",
      ),
    ).toEqual([]);
  });

  it("honours an inline allow marker, and requires a reason for it", () => {
    const withReason = scanText(
      `SESSION_SECRET=${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"}  # secret-scan:allow documented example`,
    );
    expect(withReason).toHaveLength(1);
    expect(withReason[0]?.allowed).toBe("documented example");

    const bare = scanText(
      `SESSION_SECRET=${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"}  # secret-scan:allow`,
    );
    expect(bare[0]?.allowed).toBeNull();
  });
});

describe("secret scanner — output never leaks the value", () => {
  it("redacts the entire value", () => {
    expect(mask(NEON)).toBe("[REDACTED]");
    expect(mask("short")).toBe("[REDACTED]");
    expect(mask("abcdefg")).toBe("[REDACTED]");
  });

  it("never includes the discovered secret in a finding", () => {
    const findings = scanText(`DATABASE_URL=${PG_URL}`);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(JSON.stringify(f)).not.toContain(NEON);
      expect(f.masked).not.toContain(NEON);
      expect(f.masked.length).toBeLessThan(NEON.length);
    }
  });

  it("treats short and template-looking strings as placeholders", () => {
    expect(isPlaceholder("abc")).toBe(true);
    expect(isPlaceholder("<password>")).toBe(true);
    expect(isPlaceholder("${SECRET}")).toBe(true);
    expect(isPlaceholder(NEON)).toBe(false);
  });
});

describe("scanner CLI", () => {
  it("exits nonzero without echoing matched credentials or allow-list reasons", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(path.join(tmpdir(), "monarch-scan-"));
    try {
      const file = path.join(dir, "example.env");
      writeFileSync(file, `DATABASE_URL=${PG_URL}\n`);
      const run = spawnSync(process.execPath, ["scripts/scan-secrets.mjs", file], { encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stdout + run.stderr).toContain("[REDACTED]");
      expect(run.stdout + run.stderr).not.toContain(NEON);
      writeFileSync(file, `DATABASE_URL=${PG_URL} # secret-scan:allow ${NEON}\n`);
      const allowed = spawnSync(process.execPath, ["scripts/scan-secrets.mjs", file], { encoding: "utf8" });
      expect(allowed.status).toBe(0);
      expect(allowed.stdout + allowed.stderr).not.toContain(NEON);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("detects short remote database passwords even for short/common usernames", () => {
    expect(rules("DATABASE_URL=postgresql://" + "user:pw@remote.example/database")).toContain("db-url-with-password");
    expect(rules("DATABASE_URL=postgresql://" + "monarch:postgres@remote.example/database")).toContain("db-url-with-password");
  });
});
