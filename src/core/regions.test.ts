import { describe, expect, test } from "bun:test";
import { type FaceBox, type RegionInfo, isSideways, regionFromFace, sameArea } from "./regions.ts";

/**
 * How Immich 3.3.5 reads a region back into a face: `orientRegionInfo`, then the box in `applyTaggedFaces`
 * (`metadata.service.ts`), copied as they are.
 */
function immichReads(info: RegionInfo, orientation: number): FaceBox[] {
  const sideways = [5, 6, 7, 8].includes(orientation);
  const imageWidth = sideways ? info.height : info.width;
  const imageHeight = sideways ? info.width : info.height;
  return info.regions.map(({ area }) => {
    if (!area) throw new Error("no area");
    let { x: X, y: Y, w: W, h: H } = area;
    switch (orientation) {
      case 2:
        X = 1 - X;
        break;
      case 3:
        [X, Y] = [1 - X, 1 - Y];
        break;
      case 4:
        Y = 1 - Y;
        break;
      case 5:
        [X, Y] = [Y, X];
        break;
      case 6:
        [X, Y] = [1 - Y, X];
        break;
      case 7:
        [X, Y] = [1 - Y, 1 - X];
        break;
      case 8:
        [X, Y] = [Y, 1 - X];
        break;
    }
    if (sideways) [W, H] = [H, W];
    return {
      imageWidth,
      imageHeight,
      boundingBoxX1: Math.floor((X - W / 2) * imageWidth),
      boundingBoxY1: Math.floor((Y - H / 2) * imageHeight),
      boundingBoxX2: Math.floor((X + W / 2) * imageWidth),
      boundingBoxY2: Math.floor((Y + H / 2) * imageHeight),
    };
  });
}

const face: FaceBox = { boundingBoxX1: 100, boundingBoxY1: 40, boundingBoxX2: 180, boundingBoxY2: 150, imageWidth: 1440, imageHeight: 1080 };

describe("regionFromFace", () => {
  test("without an orientation, it's the box's centre and size as fractions", () => {
    const { region, width, height } = regionFromFace(face, undefined, "Robin Example");
    expect([width, height]).toEqual([1440, 1080]);
    expect(region.type).toBe("Face");
    expect(region.name).toBe("Robin Example");
    expect(sameArea(region.area!, { x: 140 / 1440, y: 95 / 1080, w: 80 / 1440, h: 110 / 1080 })).toBe(true);
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8])("Immich reads back the same face, for orientation %p", (orientation) => {
    const { region, width, height } = regionFromFace(face, orientation, "Robin Example");
    expect([width, height]).toEqual(isSideways(orientation) ? [1080, 1440] : [1440, 1080]);
    const [read] = immichReads({ width, height, regions: [region] }, orientation);
    expect(read!.imageWidth).toBe(face.imageWidth);
    expect(read!.imageHeight).toBe(face.imageHeight);
    // Immich rounds down, and fractions may land a hair under a whole pixel.
    for (const key of ["boundingBoxX1", "boundingBoxY1", "boundingBoxX2", "boundingBoxY2"] as const) {
      expect(Math.abs(read![key] - face[key])).toBeLessThanOrEqual(1);
    }
  });

  test("a sideways orientation swaps the region's size and the dimensions", () => {
    const { region, width, height } = regionFromFace(face, 6, "Robin Example");
    expect([width, height]).toEqual([1080, 1440]);
    expect(region.area!.w).toBeCloseTo(110 / 1080);
    expect(region.area!.h).toBeCloseTo(80 / 1440);
  });
});
