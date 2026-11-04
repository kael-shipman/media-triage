// A sidecar's fields, what each tool reads from them, and the writes that give both tools what's wanted
// (DESIGN.md, F2–F10). Pure: src/sidecars/ does the reading and writing, with exiftool.
//
// Fields are named as exiftool's group-qualified tags ("XMP-dc:Title"), never through its composite or MWG tags, so
// the daemon controls exactly which fields it reads and changes. Some values live in more than one field, because
// Immich writes copies that it then reads first:
// - the description: `dc:description`, and Immich's `tiff:ImageDescription`, which it reads first;
// - the date: `exif:DateTimeOriginal`, and Immich's `photoshop:DateCreated`, which it reads first (MWG). Darktable
//   reads the first and keeps the second, but has no time zones: it drops a date's offset when it reads one, and
//   writes dates without. So the second holds the capture time with its offset (see `planWrite`);
// - the tags: Darktable's `lr:hierarchicalSubject` and `dc:subject`, and Immich's `digiKam:TagsList`, which also
//   holds the title as a tag (F3).
// Immich's copies are written where they already exist, and where they're needed to hold what Darktable's fields
// can't: a date's offset, a title tag.

import { type RegionInfo } from "./regions.ts";
import { titleTag } from "./titles.ts";
import { dcSubject, isDarktableInternal, isDarktableInternalInImmich, sameTags, toDarktable, toImmich } from "./tags.ts";
import { parseWallTime } from "./naming.ts";

/** The daemon's own XMP namespace (F9). */
export const NAMESPACE = { prefix: "mediatriage", uri: "https://github.com/kael-shipman/media-triage/ns/1.0/" } as const;

/** The fields the daemon reads, as exiftool names them. */
export const TAGS = {
  toolkit: "XMP-x:XMPToolkit",
  rating: "XMP-xmp:Rating",
  title: "XMP-dc:Title",
  description: "XMP-dc:Description",
  immichDescription: "XMP-tiff:ImageDescription",
  creator: "XMP-dc:Creator",
  subject: "XMP-dc:Subject",
  hierarchicalSubject: "XMP-lr:HierarchicalSubject",
  tagsList: "XMP-digiKam:TagsList",
  date: "XMP-exif:DateTimeOriginal",
  immichDate: "XMP-photoshop:DateCreated",
  latitude: "XMP-exif:GPSLatitude",
  longitude: "XMP-exif:GPSLongitude",
  accounts: `XMP-${NAMESPACE.prefix}:Accounts`,
  regions: "XMP-mwg-rs:RegionInfo",
} as const;

/** An account's state that Immich keeps only in its database (F9). Each person's own: never mirrored. */
export interface AccountState {
  /** The account's Immich user ID. Album IDs belong to the same server, so they're kept together. */
  user: string;
  favorite: boolean;
  /** Immich's visibility: "timeline" (the default), "archive", "locked" or "hidden". */
  visibility: string;
  albums: { id: string; name: string }[];
}

/** A sidecar's fields, as read. Dates are as exiftool reads them: "YYYY:MM:DD HH:MM:SS[.sss][±HH:MM]". */
export interface XmpFields {
  /** `x:xmptk`: which XMP library wrote the file last: exiftool (Immich, the daemon) or Exiv2 (Darktable). */
  toolkit?: string;
  rating?: number;
  title?: string;
  description?: string;
  immichDescription?: string;
  creator?: string[];
  subject?: string[];
  hierarchicalSubject?: string[];
  tagsList?: string[];
  date?: string;
  immichDate?: string;
  latitude?: number;
  longitude?: number;
  accounts?: AccountState[];
  regions?: RegionInfo;
}

// Reading.

const text = (value: unknown): string | undefined => (value === undefined || value === null ? undefined : String(value));
const list = (value: unknown): string[] | undefined =>
  value === undefined || value === null ? undefined : (Array.isArray(value) ? value : [value]).map(String);
function number(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const truthy = (value: unknown): boolean => /^(true|1)$/i.test(String(value));

function parseAccounts(value: unknown): AccountState[] | undefined {
  if (value === undefined) return undefined;
  const accounts: AccountState[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (!isObject(entry) || text(entry.User) === undefined) continue;
    const albums = (Array.isArray(entry.Albums) ? entry.Albums : entry.Albums === undefined ? [] : [entry.Albums])
      .filter(isObject)
      .map((album) => ({ id: text(album.Id) ?? "", name: text(album.Name) ?? "" }))
      .filter((album) => album.id !== "");
    accounts.push({ user: text(entry.User)!, favorite: truthy(entry.Favorite), visibility: text(entry.Visibility) ?? "timeline", albums });
  }
  return accounts;
}

function parseRegions(value: unknown): RegionInfo | undefined {
  if (!isObject(value)) return undefined;
  const applied = isObject(value.AppliedToDimensions) ? value.AppliedToDimensions : {};
  const list = Array.isArray(value.RegionList) ? value.RegionList : value.RegionList === undefined ? [] : [value.RegionList];
  return {
    width: number(applied.W) ?? 0,
    height: number(applied.H) ?? 0,
    regions: list.filter(isObject).map((raw) => {
      const area = isObject(raw.Area) ? raw.Area : {};
      const [x, y, w, h] = [number(area.X), number(area.Y), number(area.W), number(area.H)];
      const rectangle = x !== undefined && y !== undefined && w !== undefined && h !== undefined && (area.Unit ?? "normalized") === "normalized";
      return { ...(rectangle ? { area: { x, y, w, h } } : {}), type: text(raw.Type), name: text(raw.Name), raw };
    }),
  };
}

/**
 * The fields in what exiftool read: its JSON for one file, with group-qualified names (`-G1`), structures (`-struct`)
 * and values without print conversion (`-n`). Numbers may come as text: src/sidecars/ keeps them as exiftool wrote
 * them, so text that looks like a number ("1.50") stays as it was.
 */
export function parseXmp(raw: Record<string, unknown>): XmpFields {
  const fields: XmpFields = {
    toolkit: text(raw[TAGS.toolkit]),
    rating: number(raw[TAGS.rating]),
    title: text(raw[TAGS.title]),
    description: text(raw[TAGS.description]),
    immichDescription: text(raw[TAGS.immichDescription]),
    creator: list(raw[TAGS.creator]),
    subject: list(raw[TAGS.subject]),
    hierarchicalSubject: list(raw[TAGS.hierarchicalSubject]),
    tagsList: list(raw[TAGS.tagsList]),
    date: text(raw[TAGS.date]),
    immichDate: text(raw[TAGS.immichDate]),
    latitude: number(raw[TAGS.latitude]),
    longitude: number(raw[TAGS.longitude]),
    accounts: parseAccounts(raw[TAGS.accounts]),
    regions: parseRegions(raw[TAGS.regions]),
  };
  for (const key of Object.keys(fields) as (keyof XmpFields)[]) if (fields[key] === undefined) delete fields[key];
  return fields;
}

// What each tool reads. Tags are in Immich's notation, without Darktable's own, which aren't synced.

export interface ToolView {
  tags: string[];
  rating?: number;
  title?: string;
  description?: string;
  date?: string;
}

/**
 * What Immich 3.3 reads from the sidecar (`metadata.service.ts`): `TagsList`, or `HierarchicalSubject` without it
 * (`getTagList`); `ImageDescription` before `Description`; the MWG date, which in a sidecar is
 * `photoshop:DateCreated` before `exif:DateTimeOriginal`; a rating of 1 to 5, and none otherwise. Titles it doesn't
 * read: the title is the tag `Title/<title>` (F3).
 */
export function immichReads(fields: XmpFields): ToolView {
  const tags = fields.tagsList ?? fields.hierarchicalSubject?.map(toImmich) ?? [];
  const description = (fields.immichDescription || fields.description || "").trim();
  const rating = fields.rating !== undefined && fields.rating >= 1 && fields.rating <= 5 ? fields.rating : undefined;
  return strip({ tags: tags.filter((tag) => !isDarktableInternalInImmich(tag)), rating, description: description || undefined, date: fields.immichDate ?? fields.date });
}

/**
 * What Darktable 5.6 reads (`src/common/exif.cc`): `lr:hierarchicalSubject`, or `dc:subject` without it;
 * `exif:DateTimeOriginal`, or `photoshop:DateCreated` without it, without its offset (`datetime.c`,
 * `dt_datetime_exif_to_numbers`).
 */
export function darktableReads(fields: XmpFields): ToolView {
  const tags = (fields.hierarchicalSubject ?? fields.subject ?? []).filter((tag) => !isDarktableInternal(tag)).map(toImmich);
  const date = fields.date ?? fields.immichDate;
  return strip({ tags, rating: fields.rating, title: fields.title, description: fields.description, date: date && withoutOffset(date) });
}

function strip(view: ToolView): ToolView {
  for (const key of Object.keys(view) as (keyof ToolView)[]) if (view[key] === undefined) delete view[key];
  return view;
}

// Dates.

const OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

/** A date's offset from UTC ("+02:00", "Z"), if it has one. */
export function offsetOf(date: string): string | undefined {
  const time = date.indexOf(" ") >= 0 ? date.slice(date.indexOf(" ")) : date.slice(10);
  return OFFSET.exec(time)?.[1];
}

/** A date without its offset: the wall time, as Darktable shows it. */
export function withoutOffset(date: string): string {
  const offset = offsetOf(date);
  return offset === undefined ? date : date.slice(0, -offset.length);
}

/** A date with this offset, in place of any it had. */
function withOffset(date: string, offset: string | undefined): string {
  return offset === undefined ? date : `${withoutOffset(date)}${offset}`;
}

/** Whether two dates have the same wall time (to the second) and the same offset, or both none. */
function sameZonedDate(a: string | undefined, b: string | undefined): boolean {
  return sameDate(a, b) && (a === undefined || b === undefined || offsetOf(a) === offsetOf(b));
}

const pad2 = (value: number) => String(Math.trunc(value)).padStart(2, "0");

/**
 * An Immich asset's offset from UTC when it was taken, from its `localDateTime` (the wall time, written as if it were
 * UTC) and `fileCreatedAt` (the moment), or undefined when Immich doesn't know its time zone (`exifInfo.timeZone`).
 */
export function offsetFromImmich(asset: { localDateTime: string; fileCreatedAt: string; timeZone?: string | null }): string | undefined {
  if (!asset.timeZone) return undefined;
  const minutes = Math.round((Date.parse(asset.localDateTime) - Date.parse(asset.fileCreatedAt)) / 60_000);
  if (!Number.isFinite(minutes)) return undefined;
  const sign = minutes < 0 ? "-" : "+";
  return `${sign}${pad2(Math.abs(minutes) / 60)}:${pad2(Math.abs(minutes) % 60)}`;
}

/** An Immich asset's capture time as the daemon compares dates: its wall time, with its offset when Immich knows it. */
export function dateFromImmich(asset: { localDateTime: string; fileCreatedAt: string; timeZone?: string | null }): string {
  const wall = asset.localDateTime.replace(/Z$/, "").replace("T", " ").replace(/^(\d{4})-(\d{2})-(\d{2})/, "$1:$2:$3");
  return withOffset(wall, offsetFromImmich(asset));
}

/**
 * Whether two dates are the same moment as both tools see it: the same wall time to the second, and the same offset
 * when both have one. Darktable keeps neither sub-seconds nor offsets (it rewrites Immich's
 * "2020-06-15T10:30:00.000+02:00" as "2020:06:15 10:30:00.000").
 */
export function sameDate(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const [wallA, wallB] = [parseWallTime(a), parseWallTime(b)];
  if (!wallA || !wallB) return a === b;
  const sameWall = (Object.keys(wallA) as (keyof typeof wallA)[]).every((key) => wallA[key] === wallB[key]);
  const [offsetA, offsetB] = [offsetOf(a), offsetOf(b)];
  return sameWall && (offsetA === undefined || offsetB === undefined || offsetA === offsetB);
}


// Writing.

/**
 * What the daemon wants a sidecar to say. Each value given is applied and the others are left alone; null removes a
 * value.
 */
export interface Wanted {
  rating?: number | null;
  title?: string | null;
  description?: string | null;
  creator?: string | null;
  /** In Immich's notation, without Darktable's own tags, which are left as they are in every field. */
  tags?: readonly string[];
  date?: string | null;
  /**
   * The capture time's offset from UTC ("+02:00"), when it's known from elsewhere (Immich, `offsetFromImmich`), for a
   * date that has none and a sidecar that has none either.
   */
  offset?: string;
  gps?: { latitude: number; longitude: number } | null;
  /** Every account's state. Accounts with nothing to record aren't written. */
  accounts?: readonly AccountState[];
  regions?: RegionInfo | null;
}

/** exiftool's assignments: a group-qualified field and its new value, or null to remove the field. */
export type Assignments = Record<string, unknown>;

/** GPS positions this close (in degrees, about 1 cm) are the same: exiftool writes XMP's degrees and minutes. */
const GPS_TOLERANCE = 1e-7;

/**
 * The fields to write so that the sidecar says what's wanted, for both tools. Only fields whose value has to change
 * are in it, so an empty result means there's nothing to write.
 */
export function planWrite(fields: XmpFields, wanted: Wanted): Assignments {
  const plan: Assignments = {};
  const set = (tag: string, value: unknown) => {
    plan[tag] = value;
  };

  if (wanted.rating !== undefined && wanted.rating !== (fields.rating ?? null)) set(TAGS.rating, wanted.rating);
  if (wanted.title !== undefined && wanted.title !== (fields.title ?? null)) set(TAGS.title, wanted.title);

  if (wanted.description !== undefined) {
    if (wanted.description !== (fields.description ?? null)) set(TAGS.description, wanted.description);
    if (fields.immichDescription !== undefined && wanted.description !== fields.immichDescription) set(TAGS.immichDescription, wanted.description);
  }

  if (wanted.creator !== undefined) {
    const creator = wanted.creator === null ? [] : [wanted.creator];
    if (!sameList(creator, fields.creator ?? [])) set(TAGS.creator, wanted.creator === null ? null : creator);
  }

  if (wanted.tags !== undefined) {
    const hierarchical = [...(fields.hierarchicalSubject ?? []).filter(isDarktableInternal), ...wanted.tags.map(toDarktable)];
    setList(plan, TAGS.hierarchicalSubject, hierarchical, fields.hierarchicalSubject);
    setList(plan, TAGS.subject, dcSubject(hierarchical), fields.subject);
    // Immich's tags hold the title as a tag (F3), which Darktable's fields don't. So `TagsList` is written where it
    // exists, and also where there's a title: without it, Immich would read Darktable's fields, and miss the title.
    const title = wanted.title !== undefined ? wanted.title : (fields.title ?? null);
    if (fields.tagsList !== undefined || title !== null) {
      const immich = [...(fields.tagsList ?? []).filter(isDarktableInternalInImmich), ...wanted.tags, ...(title !== null ? [titleTag(title)] : [])];
      setList(plan, TAGS.tagsList, immich, fields.tagsList);
    }
  }

  if (wanted.date === null) {
    if (fields.date !== undefined) set(TAGS.date, null);
    if (fields.immichDate !== undefined) set(TAGS.immichDate, null);
  } else if (wanted.date !== undefined) {
    // The capture time, with an offset if one is known: the date's own, or else the sidecar's (a date set in Darktable
    // has none, and the zone didn't change), or else one known from elsewhere.
    const offset = offsetOf(wanted.date) ?? (fields.immichDate && offsetOf(fields.immichDate)) ?? (fields.date && offsetOf(fields.date)) ?? wanted.offset;
    const date = withOffset(wanted.date, offset);
    // Immich's field holds it whole. It's added where it's missing only to keep an offset, which Darktable's own field
    // loses each time Darktable writes the sidecar, but this one keeps.
    const immich = fields.immichDate !== undefined ? !sameZonedDate(date, fields.immichDate) : offsetOf(date) !== undefined && offsetOf(fields.date ?? "") !== offsetOf(date);
    // Darktable's field is written when its wall time changes, or along with Immich's. Only a lost offset isn't a
    // reason to write: Darktable would drop it again, and list the sidecar as changed each time.
    if (immich || !sameDate(date, fields.date)) set(TAGS.date, date);
    if (immich) set(TAGS.immichDate, date);
  }

  if (wanted.gps !== undefined) {
    if (wanted.gps === null) {
      if (fields.latitude !== undefined) set(TAGS.latitude, null);
      if (fields.longitude !== undefined) set(TAGS.longitude, null);
    } else if (!near(wanted.gps.latitude, fields.latitude) || !near(wanted.gps.longitude, fields.longitude)) {
      set(TAGS.latitude, wanted.gps.latitude);
      set(TAGS.longitude, wanted.gps.longitude);
    }
  }

  if (wanted.accounts !== undefined) {
    const value = serializeAccounts(wanted.accounts);
    if (JSON.stringify(value) !== JSON.stringify(serializeAccounts(fields.accounts ?? []))) set(TAGS.accounts, value.length === 0 ? null : value);
  }

  if (wanted.regions !== undefined) {
    const value = wanted.regions === null || wanted.regions.regions.length === 0 ? null : serializeRegions(wanted.regions);
    const current = fields.regions === undefined || fields.regions.regions.length === 0 ? null : serializeRegions(fields.regions);
    if (canonical(value) !== canonical(current)) set(TAGS.regions, value);
  }

  return plan;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Sets a list field when it isn't already the same set; an empty list removes the field. */
function setList(plan: Assignments, tag: string, value: string[], current: string[] | undefined): void {
  const unique = [...new Set(value)];
  if (!sameTags(unique, current ?? [])) plan[tag] = unique.length === 0 ? null : unique;
}

const near = (a: number, b: number | undefined) => b !== undefined && Math.abs(a - b) <= GPS_TOLERANCE;

/**
 * Accounts as written: only those with something to record, in a stable order, with defaults left out (no
 * `Favorite` when false, no `Visibility` when "timeline", no `Albums` when there are none).
 */
function serializeAccounts(accounts: readonly AccountState[]): Record<string, unknown>[] {
  return accounts
    .filter((account) => account.favorite || account.visibility !== "timeline" || account.albums.length > 0)
    .toSorted((a, b) => a.user.localeCompare(b.user))
    .map((account) => ({
      User: account.user,
      // exiftool-vendored writes booleans, but not inside a structure: exiftool reads "True" as one.
      ...(account.favorite ? { Favorite: "True" } : {}),
      ...(account.visibility !== "timeline" ? { Visibility: account.visibility } : {}),
      ...(account.albums.length > 0
        ? { Albums: account.albums.toSorted((a, b) => a.id.localeCompare(b.id)).map((album) => ({ Id: album.id, Name: album.name })) }
        : {}),
    }));
}

/** Regions as written: each one as it was read, with the fields modelled here put over it. */
function serializeRegions(info: RegionInfo): Record<string, unknown> {
  return {
    AppliedToDimensions: { W: info.width, H: info.height, Unit: "pixel" },
    RegionList: info.regions.map((region) => {
      const raw = region.raw ?? {};
      const area = region.area ? { ...(isObject(raw.Area) ? raw.Area : {}), X: region.area.x, Y: region.area.y, W: region.area.w, H: region.area.h, Unit: "normalized" } : raw.Area;
      const fields: Record<string, unknown> = { ...raw, Area: area };
      for (const [key, value] of [
        ["Type", region.type],
        ["Name", region.name],
      ] as const) {
        if (value === undefined) delete fields[key];
        else fields[key] = value;
      }
      return fields;
    }),
  };
}

/** A structure as comparable text: keys sorted, numbers rounded to a millionth, numbers in text read as numbers. */
function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (isObject(item)) return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    const parsed = typeof item === "string" && item.trim() !== "" ? Number(item) : item;
    return typeof parsed === "number" && Number.isFinite(parsed) ? Math.round(parsed * 1e6) / 1e6 : item;
  };
  return JSON.stringify(normalize(value)) ?? "null";
}
