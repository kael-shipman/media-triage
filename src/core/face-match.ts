// Putting an old copy's face corrections back on a new copy after filing (DESIGN.md, section 7): match the new copy's
// faces to the old copy's by overlap, an intersection over union above 0.5 as Immich's own detection uses
// (`person.service.ts`, `handleDetectFaces`), then reassign, add or delete to make the new copy say what the old one
// did. Boxes are compared as fractions of the image, since the two copies' faces may be measured in different sizes.

import type { FaceBox } from "./regions.ts";

/** A box as fractions of the image. */
interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const fractions = (face: FaceBox): Box => ({
  x1: face.boundingBoxX1 / face.imageWidth,
  y1: face.boundingBoxY1 / face.imageHeight,
  x2: face.boundingBoxX2 / face.imageWidth,
  y2: face.boundingBoxY2 / face.imageHeight,
});

/** The overlap of two faces: their intersection's area over their union's. */
export function overlap(a: FaceBox, b: FaceBox): number {
  const [x, y] = [fractions(a), fractions(b)];
  const width = Math.max(0, Math.min(x.x2, y.x2) - Math.max(x.x1, y.x1));
  const height = Math.max(0, Math.min(x.y2, y.y2) - Math.max(x.y1, y.y1));
  const intersection = width * height;
  const union = (x.x2 - x.x1) * (x.y2 - x.y1) + (y.x2 - y.x1) * (y.y2 - y.y1) - intersection;
  return union > 0 ? intersection / union : 0;
}

export const MATCH_OVERLAP = 0.5;

/** A face on the old copy, from the state: deleted ones too, since a deletion is a correction. */
export interface OldFace extends FaceBox {
  id: string;
  person: string | null;
  /** "machine-learning", "exif" or "manual". */
  source: string;
  deleted: boolean;
}

/** A face on the new copy, as Immich shows it now. */
export interface NewFace extends FaceBox {
  id: string;
  person: string | null;
}

export type FaceAction =
  | { kind: "reassign"; face: string; person: string }
  | { kind: "add"; person: string; box: FaceBox }
  | { kind: "delete"; face: string }
  /** A detected face of someone, with nothing on the new copy to match it: reported. */
  | { kind: "unmatched"; person: string };

/** Pairs old faces with new ones, the best overlaps first, each face at most once. */
export function matchFaces(old: readonly OldFace[], fresh: readonly NewFace[]): Map<string, NewFace> {
  const pairs = old.flatMap((a) => fresh.map((b) => ({ a, b, overlap: overlap(a, b) }))).filter((pair) => pair.overlap > MATCH_OVERLAP);
  pairs.sort((p, q) => q.overlap - p.overlap);
  const matched = new Map<string, NewFace>();
  const used = new Set<string>();
  for (const { a, b } of pairs) {
    if (matched.has(a.id) || used.has(b.id)) continue;
    matched.set(a.id, b);
    used.add(b.id);
  }
  return matched;
}

/**
 * What to do so the new copy's faces say what the old copy's did: a face whose person differs is reassigned, a face
 * added by hand with no match is added, a face deleted on the old copy is deleted on the new one.
 */
export function faceActions(old: readonly OldFace[], fresh: readonly NewFace[]): FaceAction[] {
  const matched = matchFaces(old, fresh);
  const actions: FaceAction[] = [];
  for (const face of old) {
    const match = matched.get(face.id);
    if (face.deleted) {
      if (match) actions.push({ kind: "delete", face: match.id });
      continue;
    }
    if (face.person === null) continue;
    if (match) {
      if (match.person !== face.person) actions.push({ kind: "reassign", face: match.id, person: face.person });
    } else if (face.source === "manual") {
      actions.push({ kind: "add", person: face.person, box: face });
    } else {
      actions.push({ kind: "unmatched", person: face.person });
    }
  }
  return actions;
}

/**
 * Whether the new copy's faces are still to come: the old copy had faces Immich detected (not added by hand), and
 * some of them have no match on the new copy yet, or a match Immich hasn't recognized yet (no person, where the old
 * face had one).
 */
export function awaitingDetection(old: readonly OldFace[], fresh: readonly NewFace[]): boolean {
  const detected = old.filter((face) => face.source !== "manual");
  if (detected.length === 0) return false;
  const matched = matchFaces(detected, fresh);
  return detected.some((face) => {
    const match = matched.get(face.id);
    return !match || (face.person !== null && !face.deleted && match.person === null);
  });
}
