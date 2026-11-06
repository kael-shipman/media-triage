import { describe, expect, test } from "bun:test";
import { dcSubject, isDarktableInternal, mergeTags, sameTags, toDarktable, toImmich } from "./tags.ts";

describe("translating between the tools", () => {
  test.each([
    ["People|Robin", "People/Robin"],
    ["Selected|Highlights", "Selected/Highlights"],
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
  expect(dcSubject(["People|Robin Example", "Selected|Highlights", "People|Sam"])).toEqual(["People", "Robin Example", "Selected", "Highlights", "Sam"]);
});

test("Darktable's own tags are recognized", () => {
  expect(isDarktableInternal("darktable|format|jpg")).toBe(true);
  expect(isDarktableInternal("darktable")).toBe(true);
  expect(isDarktableInternal("darktables|x")).toBe(false);
  expect(isDarktableInternal("People|darktable")).toBe(false);
});

describe("mergeTags", () => {
  const sides = (...lists: string[][]) => lists.map((tags) => ({ tags }));

  test("applies each side's additions and removals since the base", () => {
    const base = ["A", "B", "C"];
    const immich = ["A", "B", "C", "D"]; // added D
    const darktable = ["A", "C"]; // removed B
    const otherAccount = ["A", "B", "C", "E"]; // added E
    expect(mergeTags(base, sides(immich, darktable, otherAccount))).toEqual(["A", "C", "D", "E"]);
  });

  test("a tag removed on one side and kept on the others is removed", () => {
    expect(mergeTags(["A"], sides(["A"], [], ["A"]))).toEqual([]);
  });

  test("with no changes, it's the base", () => {
    expect(mergeTags(["B", "A"], sides(["A", "B"], ["B", "A"]))).toEqual(["A", "B"]);
  });

  test("without a base, it's the union", () => {
    expect(mergeTags(undefined, sides(["A"], ["B"], []))).toEqual(["A", "B"]);
  });

  test("a side compared with what it held at the last sync: one that hasn't caught up changes nothing", () => {
    // The copy never read the sidecar: it held neither B nor C then, and still doesn't. Darktable added C.
    expect(mergeTags(["A", "B"], [{ tags: ["A", "B", "C"] }, { tags: ["A"], last: ["A"] }])).toEqual(["A", "B", "C"]);
    // It still holds D, which the last sync removed: that isn't an addition.
    expect(mergeTags(["A"], [{ tags: ["A"] }, { tags: ["A", "D"], last: ["A", "D"] }])).toEqual(["A"]);
    // Its own changes since then do apply: it added E and removed A.
    expect(mergeTags(["A", "B"], [{ tags: ["A", "B"] }, { tags: ["E"], last: ["A"] }])).toEqual(["B", "E"]);
  });
});

test("sameTags ignores order and repeats", () => {
  expect(sameTags(["A", "B"], ["B", "A", "A"])).toBe(true);
  expect(sameTags(["A"], ["A", "B"])).toBe(false);
});
