import { describe, expect, test } from "bun:test";
import { fileName, filingName, freeCollision, parseWallTime, sidecarName } from "./naming.ts";

describe("parseWallTime", () => {
  test.each([
    ["2026:01:25 11:17:55.238", { year: 2026, month: 1, day: 25, hour: 11, minute: 17, second: 55 }],
    ["2026-01-25T11:17:55+01:00", { year: 2026, month: 1, day: 25, hour: 11, minute: 17, second: 55 }],
    ["2026:01:25 11:17", { year: 2026, month: 1, day: 25, hour: 11, minute: 17, second: 0 }],
  ])("%p", (text, time) => {
    expect(parseWallTime(text)).toEqual(time);
  });

  test.each(["", "2026:13:01 00:00:00", "0000:00:00 00:00:00", "yesterday"])("rejects %p", (text) => {
    expect(parseWallTime(text)).toBeUndefined();
  });
});

describe("filingName", () => {
  const time = parseWallTime("2026:01:25 09:07:05")!;

  test("matches Darktable's Archive RAW preset", () => {
    expect(filingName({ root: "Pictures", time, title: "Misc Life", creator: "Alex Example" })).toEqual({
      folder: "Pictures/2026.01.25 - Misc Life",
      stem: "2026.01.25-09.07.05 - Alex Example",
    });
  });

  test("an unknown creator is Darktable's fallback, and a slash can't make a folder", () => {
    expect(filingName({ root: "Videos/Clips", time, title: "x", creator: " " }).stem).toBe("2026.01.25-09.07.05 - unknown creator");
    expect(filingName({ root: "Pictures", time, title: "x", creator: "A/B" }).stem).toBe("2026.01.25-09.07.05 - A_B");
  });
});

describe("collisions", () => {
  test("names and sidecars", () => {
    expect(fileName("s", "jpg", 0)).toBe("s.jpg");
    expect(fileName("s", "jpg", 1)).toBe("s_01.jpg");
    expect(fileName("s", "JPG", 12)).toBe("s_12.JPG");
    expect(sidecarName("s_01.jpg")).toBe("s_01.jpg.xmp");
  });

  test("the first number free for every file of the unit, sidecars included", () => {
    const taken = new Set(["s.jpg", "s_01.mov", "s_02.jpg.xmp"]);
    expect(freeCollision("s", ["jpg"], (name) => taken.has(name))).toBe(1);
    expect(freeCollision("s", ["jpg", "mov"], (name) => taken.has(name))).toBe(3);
    expect(freeCollision("t", ["jpg"], (name) => taken.has(name))).toBe(0);
  });
});
