import { describe, expect, test } from "bun:test";
import { formatDuration, parseDuration } from "./duration.ts";

describe("parseDuration", () => {
  test.each([
    ["500ms", 500],
    ["90s", 90_000],
    ["5m", 300_000],
    ["6h", 21_600_000],
    ["1d", 86_400_000],
    ["1h30m", 5_400_000],
    ["1.5h", 5_400_000],
    [" 2m ", 120_000],
  ])("%p is %p ms", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  test.each(["", "5", "5x", "-5m", "m5", "5 m", "1h 30m"])("rejects %p", (text) => {
    expect(() => parseDuration(text)).toThrow("isn't a duration");
  });
});

describe("formatDuration", () => {
  test.each([
    [500, "500ms"],
    [90_000, "1m30s"],
    [21_600_000, "6h"],
    [86_400_000 + 60_000, "1d1m"],
  ])("%p ms is %p", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
