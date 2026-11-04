// Face regions in a sidecar (DESIGN.md, F10): MWG's `mwg-rs:Regions`, the standard Lightroom, digiKam and Picasa use,
// which Darktable keeps and transforms on export, and Immich can read.
//
// A region's area is its centre and size, as fractions of the image ("normalized"), in the image as stored: before
// its EXIF orientation is applied. Immich's faces are boxes in pixels of the image as shown, with the orientation
// applied. Immich reads regions by rotating them with the orientation (`metadata.service.ts`, `orientRegionInfo`),
// so a region made here undoes that, and Immich reads back the face it came from.

/** An area, as fractions of the image: its centre (`x`, `y`) and size (`w`, `h`). */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Region {
  /** Its rectangle, or undefined for a region that isn't a normalized rectangle (MWG also allows circles and points). */
  area?: Area;
  /** "Face" for a face. MWG also has "Pet", "Focus", "BarCode". */
  type?: string;
  name?: string;
  /** The region as it was read, if it was, so writing it back keeps the fields this doesn't model. */
  raw?: Record<string, unknown>;
}

export interface RegionInfo {
  /** The image's size in pixels when the regions were made (`AppliedToDimensions`), as stored. */
  width: number;
  height: number;
  regions: Region[];
}

/** A face as Immich reports it: a box in pixels of the image as shown (`AssetFaceResponseDto`). */
export interface FaceBox {
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
  imageWidth: number;
  imageHeight: number;
}

/** EXIF orientations 5 to 8 turn the image on its side, swapping its width and height. */
export function isSideways(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

/**
 * A point (fractions of the image) from the image as shown back to the image as stored: the inverse of Immich's
 * `orientRegionInfo` for each EXIF orientation. Orientation 1, or none, changes nothing.
 */
function toStored(orientation: number | undefined, x: number, y: number): [number, number] {
  switch (orientation) {
    case 2: // mirrored horizontally
      return [1 - x, y];
    case 3: // rotated 180°
      return [1 - x, 1 - y];
    case 4: // mirrored vertically
      return [x, 1 - y];
    case 5: // mirrored horizontally, rotated 270° clockwise
      return [y, x];
    case 6: // rotated 90° clockwise
      return [y, 1 - x];
    case 7: // mirrored horizontally, rotated 90° clockwise
      return [1 - y, 1 - x];
    case 8: // rotated 270° clockwise
      return [1 - y, x];
    default:
      return [x, y];
  }
}

/**
 * The region for a face Immich found, given the EXIF orientation Immich used for the image (the asset's
 * `exifInfo.orientation`). `AppliedToDimensions` is the size of the image Immich measured the face in, turned back to
 * the stored image's way round.
 */
export function regionFromFace(face: FaceBox, orientation: number | undefined, name: string): { region: Region; width: number; height: number } {
  const { imageWidth, imageHeight } = face;
  const centreX = (face.boundingBoxX1 + face.boundingBoxX2) / 2 / imageWidth;
  const centreY = (face.boundingBoxY1 + face.boundingBoxY2) / 2 / imageHeight;
  let w = (face.boundingBoxX2 - face.boundingBoxX1) / imageWidth;
  let h = (face.boundingBoxY2 - face.boundingBoxY1) / imageHeight;
  const [x, y] = toStored(orientation, centreX, centreY);
  const sideways = isSideways(orientation);
  if (sideways) [w, h] = [h, w];
  return {
    region: { area: { x, y, w, h }, type: "Face", name },
    width: sideways ? imageHeight : imageWidth,
    height: sideways ? imageWidth : imageHeight,
  };
}

/** Whether two areas are the same, to within `tolerance` (a fraction of the image). */
export function sameArea(a: Area, b: Area, tolerance = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.w - b.w) <= tolerance && Math.abs(a.h - b.h) <= tolerance;
}
