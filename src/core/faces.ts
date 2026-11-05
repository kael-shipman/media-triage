// Named faces in a sidecar (DESIGN.md, F10): a `People/<name>` tag for every named, visible person with a face in the
// photo, and for photos a face region for each of their faces. One way, from Immich's faces: when a face is renamed or
// removed, its tag and region go. The state records which tags and regions the daemon made, since a `People/…` tag
// that was there before is hand made and stays, and regions from other tools stay too.

import { type Area, type FaceBox, type Region, type RegionInfo, regionFromFace, sameArea } from "./regions.ts";

/** A face to show in the sidecar: its person's name, as the account whose copy it's on calls them. */
export interface NamedFace {
  /** The person group's ID. */
  person: string;
  name: string;
  face: FaceBox;
}

/** A region the daemon made, as the state records it. */
export interface MadeRegion {
  name: string;
  area: Area;
}

/** The tag for a person, in Immich's notation. A "/" in a name would nest the tag, so it's "|" (F4's translation). */
export function personTag(name: string): string {
  return `People/${name.trim().replaceAll("/", "|")}`;
}

/** Regions read back can differ from the ones written in the last digits. */
const AREA_TOLERANCE = 1e-5;

export interface FacesInput {
  /** The merged tags, in Immich's notation. */
  tags: readonly string[];
  faces: readonly NamedFace[];
  /** Whether to write regions: photos only, since a video's faces come from a single frame. */
  photo: boolean;
  /** The EXIF orientation Immich used for the image (`exifInfo.orientation`). */
  orientation?: number;
  /** The sidecar's regions, if it has any. */
  regions: RegionInfo | undefined;
  /** What the daemon made last time (the unit's state). */
  made: { tags: readonly string[]; regions: readonly MadeRegion[] };
}

export interface FacesOutcome {
  tags: string[];
  /** The tags the daemon made, to record. */
  madeTags: string[];
  /** The sidecar's regions as they should be, or undefined to leave them as they are (not a photo). */
  regions?: RegionInfo;
  madeRegions: MadeRegion[];
}

export function applyFaces(input: FacesInput): FacesOutcome {
  // Tags: a person's tag is the daemon's if it made it before, or if it adds it now; one already there is hand made.
  const tags = new Set(input.tags);
  const madeBefore = new Set(input.made.tags);
  const wanted = new Set(input.faces.map((face) => personTag(face.name)));
  const madeTags: string[] = [];
  for (const tag of wanted) {
    if (madeBefore.has(tag) || !tags.has(tag)) {
      tags.add(tag);
      madeTags.push(tag);
    }
  }
  for (const tag of madeBefore) if (!wanted.has(tag)) tags.delete(tag);
  const outcome: FacesOutcome = { tags: [...tags].sort(), madeTags: madeTags.sort(), madeRegions: [...input.made.regions] };
  if (!input.photo) return outcome;

  // Regions: other tools' are kept as they were read; the daemon's are made again from the faces.
  const isMade = (region: Region) =>
    region.area !== undefined && input.made.regions.some((made) => made.name === region.name && sameArea(made.area, region.area!, AREA_TOLERANCE));
  const kept = (input.regions?.regions ?? []).filter((region) => !isMade(region));
  const derived = input.faces.map((face) => regionFromFace(face.face, input.orientation, face.name));
  outcome.regions = {
    width: derived[0]?.width ?? input.regions?.width ?? 0,
    height: derived[0]?.height ?? input.regions?.height ?? 0,
    regions: [...kept, ...derived.map((made) => made.region)],
  };
  outcome.madeRegions = derived.map((made) => ({ name: made.region.name!, area: made.region.area! }));
  return outcome;
}
