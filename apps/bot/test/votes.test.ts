import { describe, expect, it, vi } from "vitest";
import { VoteGate, topGgCheck } from "../src/votes.js";

const options = { token: "test", botId: () => "123456789012345678" };

describe("top.gg voter gate", () => {
  it("unlocks every perk without a token", async () => {
    const gate = new VoteGate({ botId: options.botId });
    expect(gate.enabled).toBe(false);
    expect(await gate.hasVoted("123456789012345678")).toBe(true);
  });
  it("caches positive and negative responses with separate TTLs and supports re-check", async () => {
    let now = 1000;
    const fetchVote = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValue(false);
    const gate = new VoteGate({ ...options, fetchVote, now: () => now, votedTtlMs: 5000, unvotedTtlMs: 500 });
    expect(await gate.hasVoted("user")).toBe(false);
    expect(await gate.hasVoted("user")).toBe(false);
    now += 501;
    expect(await gate.hasVoted("user")).toBe(true);
    expect(await gate.hasVoted("user")).toBe(true);
    gate.forget("user");
    expect(await gate.hasVoted("user")).toBe(false);
    expect(fetchVote).toHaveBeenCalledTimes(3);
  });
  it("fails open by default, or closed if required", async () => {
    const fetchVote = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await new VoteGate({ ...options, fetchVote }).hasVoted("user")).toBe(true);
    expect(await new VoteGate({ ...options, fetchVote, required: true }).hasVoted("user")).toBe(false);
  });
  it("sends raw token to top.gg and parses the check response", async () => {
    const original = globalThis.fetch;
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ voted: 1 }) });
    globalThis.fetch = fetcher;
    try {
      expect(await topGgCheck("bot", "user", "secret")).toBe(true);
      expect(fetcher).toHaveBeenCalledWith("https://top.gg/api/bots/bot/check?userId=user", {
        headers: { Authorization: "secret" },
      });
    } finally { globalThis.fetch = original; }
  });
});
