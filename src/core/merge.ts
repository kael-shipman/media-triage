// The merge (DESIGN.md, sections 5 and 6): what a unit should say everywhere, from what each side says now and what
// they all said when last synced (the base).
//
// The sides are Darktable's view of the sidecar and each Immich copy, read through the API. (Immich's view of the
// sidecar isn't one: it's what some copy wrote, and that copy is a side.) Each value is compared in the same form on
// every side: tags in Immich's notation with the title as its tag (F3), no rating or an empty description as null.
// - Tags merge tag by tag against the base (F4): an addition or a removal on any side applies. Without a base, it's
//   the union, which never drops a tag.
// - The rating, description, date and GPS go to the latest change (F7): of the sides that differ from the base, the
//   one that changed last. Without a base, the latest side that has a value.
// - Trash (F8): a trash or a restore on a copy that isn't offline goes to every copy.
// - Two titles are a conflict (F3): the unit is left as it is, and reported.

import { sameDate } from "./xmp.ts";
import { mergeTags } from "./tags.ts";
import { titleProblem, titlesIn, withTitle } from "./titles.ts";

export interface Gps {
  latitude: number;
  longitude: number;
}

/** What a side says, in the form every side is compared in. A value it doesn't hold is left out. */
export interface SideValues {
  rating?: number | null;
  description?: string | null;
  /** Immich's notation, with the title as `Title/<title>`, without Darktable's own tags. */
  tags?: string[];
  date?: string | null;
  gps?: Gps | null;
  /** Copies only: whether it's in the trash, and whether that's because its file is offline (F8). */
  trashed?: boolean;
  offline?: boolean;
}

export interface Side {
  /** "darktable", or an account and asset, for logs. */
  name: string;
  /** When it last changed (ms): the sidecar's mtime, or the asset's `updatedAt`. */
  at: number;
  values: SideValues;
}

/** What every side said when last synced. */
export interface Base {
  rating: number | null;
  description: string | null;
  tags: string[];
  date: string | null;
  gps: Gps | null;
  trashed: boolean;
}

export interface Merged extends Base {
  title: string | null;
  /** Which side each changed value came from, for logs. */
  from: Partial<Record<keyof Base, string>>;
}

export type MergeResult = { merged: Merged } | { conflict: string };

/** A rating of 0 is no rating in both tools (Immich refuses 0, and reads it as none). */
export const normalizeRating = (rating: number | null | undefined): number | null => (rating === undefined || rating === null || rating === 0 ? null : rating);
export const normalizeDescription = (text: string | null | undefined): string | null => (text?.trim() ? text : null);

const GPS_TOLERANCE = 1e-6;
const sameGps = (a: Gps | null, b: Gps | null) =>
  a === null || b === null ? a === b : Math.abs(a.latitude - b.latitude) <= GPS_TOLERANCE && Math.abs(a.longitude - b.longitude) <= GPS_TOLERANCE;

/** The latest change to one value: of the sides that hold it and differ from the base, the one that changed last. */
function latest<T>(field: keyof Base, base: T | undefined, sides: Side[], read: (values: SideValues) => T | undefined, same: (a: T, b: T) => boolean, from: Merged["from"]): T | undefined {
  let winner: { value: T; side: Side } | undefined;
  for (const side of sides) {
    const value = read(side.values);
    if (value === undefined) continue;
    if (base !== undefined && same(value, base)) continue;
    if (base === undefined && value === null) continue;
    if (!winner || side.at > winner.side.at) winner = { value, side };
  }
  if (!winner) return base;
  if (base === undefined || !same(winner.value, base)) from[field] = winner.side.name;
  return winner.value;
}

export function mergeUnit(base: Base | undefined, title: string | null | undefined, sides: Side[]): MergeResult {
  const from: Merged["from"] = {};

  const tagSides = sides.flatMap((side) => (side.values.tags ? [side.values.tags] : []));
  const tags = mergeTags(base && withTitle(base.tags, title ?? undefined), tagSides);
  const titles = titlesIn(tags);
  if (titles.length > 1) return { conflict: `it has two titles: ${titles.map((text) => JSON.stringify(text)).join(" and ")}` };
  const problem = titles[0] !== undefined ? titleProblem(titles[0]) : undefined;
  if (problem) return { conflict: `its title ${JSON.stringify(titles[0])} can't be used: ${problem}` };
  if (!base || tags.join("\n") !== withTitle(base.tags, title ?? undefined).toSorted().join("\n")) from.tags = "merge";

  const rating = latest("rating", base?.rating, sides, (values) => (values.rating === undefined ? undefined : normalizeRating(values.rating)), (a, b) => a === b, from) ?? null;
  const description =
    latest("description", base?.description, sides, (values) => (values.description === undefined ? undefined : normalizeDescription(values.description)), (a, b) => a === b, from) ?? null;
  const date = latest("date", base?.date, sides, (values) => values.date, (a, b) => (a === null || b === null ? a === b : sameDate(a, b)), from) ?? null;
  const gps = latest("gps", base?.gps, sides, (values) => values.gps, sameGps, from) ?? null;

  // F8: only copies that aren't offline count, since Immich marks an offline file as trashed too.
  const copies = sides.filter((side) => side.values.trashed !== undefined && !side.values.offline);
  const trashed = latest("trashed", base?.trashed ?? false, copies, (values) => values.trashed, (a, b) => a === b, from) ?? false;

  return { merged: { rating, description, tags: withTitle(tags, undefined).sort(), title: titles[0] ?? null, date, gps, trashed, from } };
}
