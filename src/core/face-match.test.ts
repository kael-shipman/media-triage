import { expect, test } from "bun:test";
import { type NewFace, type OldFace, awaitingDetection, faceActions, overlap } from "./face-match.ts";

/** A face as fractions of a 1000×800 image (old) or a 2000×1600 one (new): the same place, measured twice. */
const box = (x: number, y: number, size: number, scale = 1) => ({
  boundingBoxX1: x * 1000 * scale,
  boundingBoxY1: y * 800 * scale,
  boundingBoxX2: (x + size) * 1000 * scale,
  boundingBoxY2: (y + size) * 800 * scale,
  imageWidth: 1000 * scale,
  imageHeight: 800 * scale,
});
const old = (id: string, person: string | null, at: number, changes: Partial<OldFace> = {}): OldFace => ({ id, person, source: "machine-learning", deleted: false, ...box(at, at, 0.2), ...changes });
const fresh = (id: string, person: string | null, at: number): NewFace => ({ id, person, ...box(at, at, 0.2, 2) });

test("overlap is measured as fractions of each image", () => {
  expect(overlap(box(0.1, 0.1, 0.2), box(0.1, 0.1, 0.2, 2))).toBeCloseTo(1);
  expect(overlap(box(0.1, 0.1, 0.2), box(0.2, 0.1, 0.2))).toBeCloseTo(1 / 3);
  expect(overlap(box(0, 0, 0.1), box(0.5, 0.5, 0.1))).toBe(0);
});

test("corrections: a different person is reassigned, a hand-made face added, a deleted one deleted", () => {
  const before = [
    old("o1", "robin", 0.1), // recognized the same: nothing to do
    old("o2", "kit", 0.4), // corrected by hand to Kit on the old copy; the new one says Robin
    old("o3", "sam", 0.7, { source: "manual" }), // added by hand: the new copy hasn't it
    old("o4", null, 0.05, { deleted: true, ...box(0.55, 0.05, 0.2) }), // deleted on the old copy
    old("o5", "alex", 0.3, { ...box(0.3, 0.6, 0.1) }), // detected before, but not now
  ];
  const after = [fresh("n1", "robin", 0.1), fresh("n2", "robin", 0.4), { ...fresh("n4", null, 0), ...box(0.55, 0.05, 0.2, 2) }];
  expect(faceActions(before, after)).toEqual([
    { kind: "reassign", face: "n2", person: "kit" },
    { kind: "add", person: "sam", box: before[2]! },
    { kind: "delete", face: "n4" },
    { kind: "unmatched", person: "alex" },
  ]);
});

test("each face is matched once, the best overlap first", () => {
  const before = [old("o1", "robin", 0.1), old("o2", "kit", 0.12)];
  expect(faceActions(before, [fresh("n1", "kit", 0.12)])).toEqual([{ kind: "unmatched", person: "robin" }]);
});

test("detection is awaited while a detected face has no match, or no person where the old one had one", () => {
  expect(awaitingDetection([old("o1", "robin", 0.1)], [])).toBe(true);
  expect(awaitingDetection([old("o1", "robin", 0.1)], [fresh("n1", null, 0.1)])).toBe(true);
  expect(awaitingDetection([old("o1", "robin", 0.1)], [fresh("n1", "kit", 0.1)])).toBe(false);
  expect(awaitingDetection([old("o1", "robin", 0.1, { source: "manual" })], [])).toBe(false);
  expect(awaitingDetection([], [])).toBe(false);
});
