import { describe, expect, it } from "vitest";
import { MAX_DURATION_MS, formatDuration, parseDuration } from "../src/durations.js";

describe("parseDuration", () => {
  it("parses single and compound units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration(" 1H 30M ")).toBe(5_400_000);
  });

  it("rejects garbage and zero", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("10")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("5 minutes")).toBeNull();
  });

  it("caps at 28 days", () => {
    expect(parseDuration("99w")).toBe(MAX_DURATION_MS);
  });
});

describe("formatDuration", () => {
  it("renders the two most significant units", () => {
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(90_061_000)).toBe("1d 1h");
    expect(formatDuration(45_000)).toBe("45s");
  });
});
