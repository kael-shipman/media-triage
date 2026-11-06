import { describe, expect, test } from "bun:test";
import { type Base, type Side, mergeUnit } from "./merge.ts";

const base: Base = { rating: 3, description: "A day out", tags: ["Places/Lake"], date: "2021:06:15 10:20:30+02:00", gps: null, trashed: false };
const same = (name: string, at: number, extra: Partial<Side["values"]> = {}): Side => ({
  name,
  at,
  values: { rating: 3, description: "A day out", tags: ["Places/Lake", "Title/Lake day"], date: "2021:06:15 10:20:30.000", gps: null, ...extra },
});

function merged(...args: Parameters<typeof mergeUnit>) {
  const result = mergeUnit(...args);
  if (!("merged" in result)) throw new Error(result.conflict);
  return result.merged;
}

describe("mergeUnit", () => {
  test("nothing changed anywhere: the base, with nothing attributed", () => {
    const result = merged(base, "Lake day", [same("darktable", 1), same("alex", 2, { trashed: false }), same("sam", 3, { trashed: false })]);
    expect(result).toEqual({ ...base, title: "Lake day", from: {} });
  });

  test("tags merge tag by tag, from every side", () => {
    const result = merged(base, "Lake day", [
      same("darktable", 1, { tags: ["Places/Lake", "Title/Lake day", "People/Robin"] }),
      same("alex", 2, { tags: ["Title/Lake day"] }),
      same("sam", 3),
    ]);
    expect(result.tags).toEqual(["People/Robin"]);
    expect(result.title).toBe("Lake day");
    expect(result.from.tags).toBe("merge");
  });

  test("the latest change wins for the rating, description, date and GPS", () => {
    const result = merged(base, "Lake day", [
      same("darktable", 10, { rating: 5, date: "2021:06:15 11:00:00.000", gps: { latitude: 1, longitude: 2 } }),
      same("alex", 20, { rating: 1, description: "Changed" }),
      same("sam", 5, { rating: 4 }),
    ]);
    expect(result).toMatchObject({ rating: 1, description: "Changed", date: "2021:06:15 11:00:00.000", gps: { latitude: 1, longitude: 2 } });
    expect(result.from).toEqual({ rating: "alex", description: "alex", date: "darktable", gps: "darktable" });
  });

  test("a date that differs only in its offset, or a rating of 0, isn't a change", () => {
    const result = merged({ ...base, rating: null }, "Lake day", [same("darktable", 10, { rating: 0 }), same("alex", 20, { rating: null, date: "2021:06:15 10:20:30.000+02:00" })]);
    expect(result.from).toEqual({});
  });

  test("two titles are a conflict, and so is a title that can't be a folder name", () => {
    expect(mergeUnit(base, "Lake day", [same("darktable", 1, { tags: ["Title/Lake day", "Title/Other"] })])).toEqual({ conflict: 'it has two titles: "Lake day" and "Other"' });
    expect(mergeUnit(undefined, undefined, [same("darktable", 1, { tags: ["Title/A|B"] })])).toMatchObject({ conflict: expect.stringContaining("can't be used") });
  });

  test("a title removed in one tool is removed", () => {
    const result = merged(base, "Lake day", [same("darktable", 1, { tags: ["Places/Lake"] }), same("alex", 2)]);
    expect(result.title).toBeNull();
  });

  test("without a base: the union of tags, and the sidecar's values, which copies only fill in", () => {
    const result = merged(undefined, undefined, [
      { name: "darktable", at: 10, sidecar: true, values: { rating: 3, tags: ["Places/Lake", "Title/Lake day"], description: null, date: "2021:06:15 10:20:30.000", gps: null } },
      { name: "alex", at: 20, values: { rating: 5, tags: ["People/Robin"], description: "From Immich", date: "2021:06:15 11:00:00.000+02:00", gps: null, trashed: false } },
    ]);
    // The copy changed later, but Immich writes its edits to the sidecar: a copy that differs hasn't read it.
    expect(result).toMatchObject({ rating: 3, tags: ["People/Robin", "Places/Lake"], title: "Lake day", date: "2021:06:15 10:20:30.000", description: "From Immich" });
    expect(result.from).toMatchObject({ rating: "darktable", date: "darktable", description: "alex" });
  });

  test("a copy that still says what it said at the last sync changes nothing, though the merge went another way", () => {
    // It never read the sidecar (F1), or it can't show a reject (-1): it said no rating, no title and no tags then, and
    // still does.
    const last = { rating: null, description: null, tags: [], date: "2021:06:15 10:20:30.000", gps: null, trashed: false };
    const result = merged({ ...base, rating: -1 }, "Lake day", [same("darktable", 1, { rating: -1 }), { name: "alex", at: 99, values: last, last }]);
    expect(result).toMatchObject({ rating: -1, title: "Lake day", tags: ["Places/Lake"], description: "A day out" });
    expect(result.from).toEqual({});
  });

  test("a copy's own changes since the last sync apply, and two accounts' edits made just apart both stay", () => {
    const lastOf = { rating: 3, description: "A day out", tags: ["Places/Lake", "Title/Lake day"], date: "2021:06:15 10:20:30.000", gps: null, trashed: false };
    // Alex added A; then Sam added B, and Sam's copy rewrote the sidecar's Immich tags without A. Darktable's fields
    // haven't been written yet.
    const result = merged(base, "Lake day", [
      same("darktable", 1),
      { name: "alex", at: 2, values: { ...lastOf, tags: [...lastOf.tags, "A"], rating: 4 }, last: lastOf },
      { name: "sam", at: 3, values: { ...lastOf, tags: [...lastOf.tags, "B"] }, last: lastOf },
    ]);
    expect(result).toMatchObject({ tags: ["A", "B", "Places/Lake"], rating: 4 });
  });

  test("F8: a trash on a copy that's online is mirrored, an offline one isn't, and a restore is", () => {
    expect(merged(base, "Lake day", [same("alex", 2, { trashed: true }), same("sam", 1, { trashed: false })]).trashed).toBe(true);
    expect(merged(base, "Lake day", [same("alex", 2, { trashed: true, offline: true }), same("sam", 1, { trashed: false })]).trashed).toBe(false);
    expect(merged({ ...base, trashed: true }, "Lake day", [same("alex", 2, { trashed: false }), same("sam", 1, { trashed: true })]).trashed).toBe(false);
  });
});
