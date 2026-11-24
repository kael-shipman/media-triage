// People from tags (DESIGN.md, F12): a hand-made `People/…` tag adds its person to the photo, as a small square face
// near its centre, where the person has no face in any copy and the daemon hasn't added them before. Its last part is the
// person's name, as F10 writes it: a "/" in a name is "|" in the tag. Pure: src/sync/reconcile.ts reads the state and
// adds the faces.

import type { FaceBox } from "./regions.ts";

const PEOPLE = "People/";

/** A person's name as the last part of a tag: F10's translation, a "/" in the name written "|". */
export function personTagName(name: string): string {
  return name.trim().replaceAll("/", "|");
}

/** The person a `People/…` tag names: its last part, with "|" read as "/". Undefined for other tags. */
export function personNameOf(tag: string): string | undefined {
  if (!tag.startsWith(PEOPLE) || tag.length === PEOPLE.length) return undefined;
  const name = tag.slice(tag.lastIndexOf("/") + 1).replaceAll("|", "/").trim();
  return name === "" ? undefined : name;
}

/** The share of the photo's width a face added from a tag spans, on each side: small, so it's not in the way. */
export const TAG_FACE_SHARE = 0.08;

/** A box in pixels of an image `width` by `height`, as `POST /api/faces` takes it. */
export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A box as fractions of its image, so boxes measured on images of different sizes compare. */
function fractions(box: FaceBox): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: box.boundingBoxX1 / box.imageWidth,
    y1: box.boundingBoxY1 / box.imageHeight,
    x2: box.boundingBoxX2 / box.imageWidth,
    y2: box.boundingBoxY2 / box.imageHeight,
  };
}

/** 0, 1, -1, 2, -2, …, up to `limit` either way. */
function outwards(limit: number): number[] {
  const steps = [0];
  for (let step = 1; step <= limit; step++) steps.push(step, -step);
  return steps;
}

/**
 * The face added from a tag: a square, `TAG_FACE_SHARE` of the photo's width on a side, in pixels of the photo as
 * Immich measures it (at least 1 pixel, and never more than the photo). In the centre, or, where that overlaps a face
 * already there (`occupied`, any copy's, measured on any size of the image), the nearest free place in a row through
 * the centre, then in rows above and below, half a side apart. Each person needs a box of their own: the author's
 * Immich fork pairs faces between copies of a file by their boxes, so two people with one box are one face to it.
 */
export function tagFaceBox(width: number, height: number, occupied: readonly FaceBox[] = []): PixelBox {
  const side = Math.max(1, Math.min(Math.round(width * TAG_FACE_SHARE), width, height));
  const step = Math.max(1, Math.round(side * 1.5));
  const [centreX, centreY] = [Math.round((width - side) / 2), Math.round((height - side) / 2)];
  const taken = occupied.filter((face) => face.imageWidth > 0 && face.imageHeight > 0).map(fractions);
  const free = (x: number, y: number) =>
    taken.every((box) => x / width >= box.x2 || (x + side) / width <= box.x1 || y / height >= box.y2 || (y + side) / height <= box.y1);
  for (const row of outwards(Math.floor(height / step))) {
    const y = centreY + row * step;
    if (y < 0 || y + side > height) continue;
    for (const column of outwards(Math.floor(width / step))) {
      const x = centreX + column * step;
      if (x < 0 || x + side > width) continue;
      if (free(x, y)) return { x, y, width: side, height: side };
    }
  }
  return { x: centreX, y: centreY, width: side, height: side };
}

/** A box `POST /api/faces` took, as Immich then reports it: for `occupied`, within one pass. */
export function asFaceBox(box: PixelBox, width: number, height: number): FaceBox {
  return { boundingBoxX1: box.x, boundingBoxY1: box.y, boundingBoxX2: box.x + box.width, boundingBoxY2: box.y + box.height, imageWidth: width, imageHeight: height };
}

/** An account's own record of a person, as F12 needs it. */
export interface NamedPerson {
  /** The person group's ID: the same in every account of the cluster group. */
  id: string;
  hidden: boolean;
}

export interface PeopleFromTagsInput {
  /** The merged tags, in Immich's notation. */
  tags: readonly string[];
  /** The `People/…` tags the daemon made from faces (F10): not hand-made. */
  made: readonly string[];
  /** The copies the face could go on, in order: each one's account and asset. */
  copies: readonly { account: string; asset: string }[];
  /** An account's people with a name. */
  peopleNamed: (account: string, name: string) => readonly NamedPerson[];
  /** The people with a face, not deleted, in any copy of the file. */
  present: ReadonlySet<string>;
  /** The people the daemon added to this file before (`tagPeople`). */
  added: ReadonlySet<string>;
  /** Whether the server mirrors face corrections between copies: then one copy is enough. */
  mirrors: boolean;
}

export interface PeopleFromTagsPlan {
  /** The faces to add: a person on a copy. */
  add: { account: string; asset: string; person: string; name: string }[];
  /** Names an account has more than one person for: skipped. */
  ambiguous: string[];
}

export function planPeopleFromTags(input: PeopleFromTagsInput): PeopleFromTagsPlan {
  const plan: PeopleFromTagsPlan = { add: [], ambiguous: [] };
  const made = new Set(input.made);
  const names = new Set(input.tags.filter((tag) => !made.has(tag)).flatMap((tag) => personNameOf(tag) ?? []));
  const planned = new Set<string>();
  for (const name of [...names].sort()) {
    for (const copy of input.copies) {
      const people = input.peopleNamed(copy.account, name).filter((person) => !person.hidden);
      if (people.length > 1) {
        if (!plan.ambiguous.includes(name)) plan.ambiguous.push(name);
        continue;
      }
      const person = people[0];
      if (!person || input.present.has(person.id) || input.added.has(person.id)) continue;
      // With mirroring, the first copy whose account names the person; without it, each such copy.
      if (input.mirrors && planned.has(person.id)) continue;
      planned.add(person.id);
      plan.add.push({ account: copy.account, asset: copy.asset, person: person.id, name });
    }
  }
  return plan;
}
