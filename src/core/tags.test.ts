import { describe, expect, test } from "bun:test";
import { dcSubject, isDarktableInternal, mergeTags, sameTags, toDarktable, toImmich } from "./tags.ts";

describe("translating between the tools", () => {
  test.each([
    ["People|Ari", "People/Ari"],
    ["Selected|Best-Of", "Selected/Best-Of"],
    ["Plain", "Plain"],
    ["Music|AC/DC", "Music/AC|DC"],
    ["A|B|C", "A/B/C"],
  ])("Darktable %p is Immich %p, and back", (darktable, immich) => {
    expect(toImmich(darktable)).toBe(immich);
    expect(toDarktable(immich)).toBe(darktable);
  });

  test("round trips are exact, for odd names too", () => {
    for (const tag of ["a/b|c", "|x", "x/", "a||b", "a//b", "/"]) {
      expect(toImmich(toDarktable(tag))).toBe(tag);
      expect(toDarktable(toImmich(tag))).toBe(tag);
    }
  });
});

test("dc:subject holds every part of every tag, once", () => {
  expect(dcSubject(["People|Ari Lumen", "Selected|Best-Of", "People|Sam"])).toEqual(["People", "Ari Lumen", "Selected", "Best-Of", "Sam"]);
});

test("Darktable's own tags are recognized", () => {
  expect(isDarktableInternal("darktable|format|jpg")).toBe(true);
  expect(isDarktableInternal("darktable")).toBe(true);
  expect(isDarktableInternal("darktables|x")).toBe(false);
  expect(isDarktableInternal("People|darktable")).toBe(false);
});

describe("mergeTags", () => {
  test("applies each side's additions and removals since the base", () => {
    const base = ["A", "B", "C"];
    const immich = ["A", "B", "C", "D"]; // added D
    const darktable = ["A", "C"]; // removed B
    const otherAccount = ["A", "B", "C", "E"]; // added E
    expect(mergeTags(base, [immich, darktable, otherAccount])).toEqual(["A", "C", "D", "E"]);
  });

  test("a tag removed on one side and kept on the others is removed", () => {
    expect(mergeTags(["A"], [["A"], [], ["A"]])).toEqual([]);
  });

  test("with no changes, it's the base", () => {
    expect(mergeTags(["B", "A"], [["A", "B"], ["B", "A"]])).toEqual(["A", "B"]);
  });

  test("without a base, it's the union", () => {
    expect(mergeTags(undefined, [["A"], ["B"], []])).toEqual(["A", "B"]);
  });
});

test("sameTags ignores order and repeats", () => {
  expect(sameTags(["A", "B"], ["B", "A", "A"])).toBe(true);
  expect(sameTags(["A"], ["A", "B"])).toBe(false);
});
