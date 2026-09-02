import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/secure-token";
import {
  auditRowToRecord,
  designatedChannelsToColumns,
  draftRowToRecord,
  sessionRowToRecord,
  settingsRowToRecord,
  snapshotRowToRecord,
} from "@/lib/prisma-store";

/** Pure row ↔ record mappers + token encryption, no database involved. */

describe("secure-token (AES-256-GCM)", () => {
  it("round-trips a token", () => {
    const token = "MTOKEN_secret-oauth-token-12345";
    const stored = encryptSecret(token);
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(token);
    expect(decryptSecret(stored)).toBe(token);
  });

  it("never stores plaintext components", () => {
    const stored = encryptSecret("super-secret");
    const parts = stored.split(".");
    expect(parts).toHaveLength(4);
    expect(parts.every((p) => !p.toLowerCase().includes("secret"))).toBe(true);
  });

  it("produces distinct ciphertexts for the same input (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("returns undefined for absent, malformed, or tampered values", () => {
    expect(decryptSecret(null)).toBeUndefined();
    expect(decryptSecret(undefined)).toBeUndefined();
    expect(decryptSecret("garbage")).toBeUndefined();
    const stored = encryptSecret("super-secret-token");
    const parts = stored.split(".");
    const flipped = [parts[0], parts[1], parts[2], Buffer.from("tampered!").toString("base64url")].join(".");
    expect(decryptSecret(flipped)).toBeUndefined();
  });
});

describe("row → record mappers", () => {
  it("maps sessions, omitting absent OAuth tokens", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    expect(
      sessionRowToRecord(
        { id: "sess_1", userId: "u1", accessTokenEnc: null, createdAt, expiresAt: new Date(createdAt.getTime() + 1000) },
        { id: "u1", username: "alice", avatarUrl: null },
      ),
    ).toEqual({ id: "sess_1", userId: "u1", username: "alice", avatarUrl: null, createdAt: createdAt.toISOString() });
  });

  it("maps drafts (Json columns cast to ServerDesign)", () => {
    const updatedAt = new Date("2026-02-02T00:00:00.000Z");
    const design = { guildId: "g1", channels: [] } as never;
    const record = draftRowToRecord({ guildId: "g1", userId: "u1", design, baseDesign: design, updatedAt });
    expect(record.guildId).toBe("g1");
    expect(record.design).toBe(design);
    expect(record.updatedAt).toBe(updatedAt.toISOString());
  });

  it("maps snapshots with kind preserved", () => {
    const createdAt = new Date("2026-03-03T00:00:00.000Z");
    const record = snapshotRowToRecord({
      id: "snap_1", guildId: "g1", name: "before apply", kind: "pre-apply",
      design: { guildId: "g1" } as never, createdAt,
    });
    expect(record.kind).toBe("pre-apply");
    expect(record.createdAt).toBe(createdAt.toISOString());
  });

  it("maps guild settings both ways", () => {
    const row = {
      guildId: "g1",
      welcomeChannelId: "123",
      announcementsChannelId: null,
      testingChannelId: "456",
      templateTestingChannelId: null,
    };
    expect(settingsRowToRecord(row)).toEqual({
      guildId: "g1",
      designatedChannels: { welcome: "123", testing: "456" },
    });
    expect(settingsRowToRecord(null)).toEqual({ guildId: "", designatedChannels: {} });

    expect(designatedChannelsToColumns({ welcome: "123", testing: "456" })).toEqual({
      welcomeChannelId: "123",
      announcementsChannelId: null,
      testingChannelId: "456",
      templateTestingChannelId: null,
    });
    expect(designatedChannelsToColumns({})).toEqual({
      welcomeChannelId: null,
      announcementsChannelId: null,
      testingChannelId: null,
      templateTestingChannelId: null,
    });
  });

  it("maps audit entries", () => {
    const createdAt = new Date("2026-04-04T00:00:00.000Z");
    expect(
      auditRowToRecord({ id: "a1", guildId: "g1", userId: "u1", action: "apply", summary: "Applied 2 changes", createdAt }),
    ).toEqual({
      id: "a1", guildId: "g1", userId: "u1", action: "apply", summary: "Applied 2 changes", createdAt: createdAt.toISOString(),
    });
  });
});
