import { expect, test } from "bun:test";
import { type NamedFace, applyFaces, personTag } from "./faces.ts";
import type { RegionInfo } from "./regions.ts";

const box = { boundingBoxX1: 100, boundingBoxY1: 200, boundingBoxX2: 300, boundingBoxY2: 400, imageWidth: 1000, imageHeight: 800 };
const robin: NamedFace = { person: "p1", name: "Robin Example", face: box };
const none = { tags: [], regions: [] };

test("a person's tag, with a slash in a name kept from nesting it", () => {
  expect(personTag("Robin Example")).toBe("People/Robin Example");
  expect(personTag(" AC/DC ")).toBe("People/AC|DC");
});

test("named faces add their tags and regions, which the daemon then knows it made", () => {
  const outcome = applyFaces({ tags: ["Places/Lake"], faces: [robin], photo: true, regions: undefined, made: none });
  expect(outcome.tags).toEqual(["People/Robin Example", "Places/Lake"]);
  expect(outcome.madeTags).toEqual(["People/Robin Example"]);
  expect(outcome.regions).toEqual({ width: 1000, height: 800, regions: [{ area: { x: 0.2, y: 0.375, w: 0.2, h: 0.25 }, type: "Face", name: "Robin Example" }] });
  expect(outcome.madeRegions).toEqual([{ name: "Robin Example", area: { x: 0.2, y: 0.375, w: 0.2, h: 0.25 } }]);
});

test("a hand-made tag isn't the daemon's, and stays when the face goes", () => {
  const first = applyFaces({ tags: ["People/Robin Example"], faces: [robin], photo: false, regions: undefined, made: none });
  expect(first.madeTags).toEqual([]);
  const gone = applyFaces({ tags: first.tags, faces: [], photo: false, regions: undefined, made: { tags: first.madeTags, regions: [] } });
  expect(gone.tags).toEqual(["People/Robin Example"]);
});

test("a rename replaces the daemon's tag and region, and keeps other tools' regions", () => {
  const other = { area: { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, type: "Pet", name: "Rex", raw: { Name: "Rex", Type: "Pet" } };
  const first = applyFaces({ tags: [], faces: [robin], photo: true, regions: { width: 500, height: 400, regions: [other] }, made: none });
  expect(first.regions?.regions.map((region) => region.name)).toEqual(["Rex", "Robin Example"]);

  // Read back, as exiftool would give it: the numbers a little off.
  const read: RegionInfo = { ...first.regions!, regions: first.regions!.regions.map((region) => (region.name === "Robin Example" ? { ...region, area: { x: 0.2000001, y: 0.375, w: 0.2, h: 0.25 } } : region)) };
  const renamed = applyFaces({
    tags: first.tags,
    faces: [{ ...robin, name: "Robin Renamed" }],
    photo: true,
    regions: read,
    made: { tags: first.madeTags, regions: first.madeRegions },
  });
  expect(renamed.tags).toEqual(["People/Robin Renamed"]);
  expect(renamed.regions?.regions.map((region) => region.name)).toEqual(["Rex", "Robin Renamed"]);

  // The face is removed: only the other tool's region is left.
  const removed = applyFaces({ tags: renamed.tags, faces: [], photo: true, regions: renamed.regions, made: { tags: renamed.madeTags, regions: renamed.madeRegions } });
  expect(removed.tags).toEqual([]);
  expect(removed.regions?.regions).toEqual([other]);
  expect(removed.madeRegions).toEqual([]);
});

test("a video gets the tags only, and its regions are left as they are", () => {
  const outcome = applyFaces({ tags: [], faces: [robin], photo: false, regions: undefined, made: none });
  expect(outcome.tags).toEqual(["People/Robin Example"]);
  expect(outcome.regions).toBeUndefined();
});
