import { expect, test } from "bun:test";
import { isConflictCopy, isSidecar, sidecarOwner } from "./orphans.ts";

const folder = ["IMG_1.jpg", "IMG_1.jpg.xmp", "IMG_1_01.jpg.xmp", "IMG_1_02.jpg.xmp", "X_01.jpg", "X_01.jpg.xmp", "X_01_01.jpg.xmp", "clip.mp4", "clip.xmp", "gone.jpg.xmp", "gone_01.jpg.xmp", "stem.only.xmp"];

test.each([
  ["IMG_1.jpg.xmp", "IMG_1.jpg"],
  ["IMG_1_01.jpg.xmp", "IMG_1.jpg"], // a Darktable duplicate
  ["IMG_1_02.jpg.xmp", "IMG_1.jpg"],
  ["X_01.jpg.xmp", "X_01.jpg"], // a filing collision name: the exact file wins
  ["X_01_01.jpg.xmp", "X_01.jpg"], // a duplicate of it
  ["clip.xmp", "clip.mp4"], // "<stem>.xmp"
  ["gone.jpg.xmp", undefined],
  ["gone_01.jpg.xmp", undefined],
  ["stem.only.xmp", undefined],
])("%p belongs to %p", (sidecar, owner) => {
  expect(sidecarOwner(sidecar, folder)).toBe(owner);
});

test("recognizes sidecars and Syncthing conflict copies", () => {
  expect(isSidecar("a.jpg.XMP")).toBe(true);
  expect(isSidecar("a.jpg")).toBe(false);
  expect(isConflictCopy("a.jpg.sync-conflict-20261103-101010-ABCDEFG.xmp")).toBe(true);
  expect(isConflictCopy("a.jpg.xmp")).toBe(false);
});
