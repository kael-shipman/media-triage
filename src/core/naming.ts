// Where filing puts a photo or video, named as the author's Darktable "Archive RAW" export preset does
// (DESIGN.md, section 7):
//   <root>/YYYY.MM.DD - <Title>/YYYY.MM.DD-HH.MM.SS - <Creator>.<ext>
// with "_01", "_02", … before the extension when a name is taken.

export const PROMOTE_TAG = "Promote";
export const NEEDS_TITLE_TAG = "Promote/Needs a title";
/** Darktable's fallback for $(CREATOR-unknown creator). */
export const UNKNOWN_CREATOR = "unknown creator";

/** A capture time as the photo's clock showed it: no time zone. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * Reads an EXIF or XMP date-time as wall time, ignoring sub-seconds and any offset: "2026:01:25 11:17:55.238",
 * "2026-01-25T11:17:55+01:00".
 */
export function parseWallTime(text: string): WallTime | undefined {
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text.trim());
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return undefined;
  return { year, month, day, hour, minute, second };
}

/** File names can't hold "/" or NUL; Darktable's export turns "/" in a variable into a folder, which filing avoids. */
function safePart(text: string): string {
  return text.replaceAll("/", "_").replaceAll("\u0000", "");
}

export interface FilingName {
  /** The folder, relative to the archive: "<root>/YYYY.MM.DD - <Title>". */
  folder: string;
  /** The file name without the collision suffix or extension: "YYYY.MM.DD-HH.MM.SS - <Creator>". */
  stem: string;
}

export function filingName(options: { root: string; time: WallTime; title: string; creator?: string }): FilingName {
  const { year, month, day, hour, minute, second } = options.time;
  const date = `${pad(year, 4)}.${pad(month)}.${pad(day)}`;
  const creator = options.creator?.trim() ? options.creator.trim() : UNKNOWN_CREATOR;
  return {
    folder: `${options.root}/${date} - ${safePart(options.title)}`,
    stem: `${date}-${pad(hour)}.${pad(minute)}.${pad(second)} - ${safePart(creator)}`,
  };
}

/** The file name for a stem, extension and collision number: 0 is none, 1 is "_01". */
export function fileName(stem: string, extension: string, collision: number): string {
  return collision === 0 ? `${stem}.${extension}` : `${stem}_${pad(collision)}.${extension}`;
}

export function sidecarName(file: string): string {
  return `${file}.xmp`;
}

/**
 * The lowest collision number at which every file of a unit (a photo, and a Live Photo's video) and their sidecars
 * are free. Keeping one number for the whole unit keeps a Live Photo's two files paired by name.
 */
export function freeCollision(stem: string, extensions: string[], taken: (name: string) => boolean): number {
  for (let collision = 0; ; collision++) {
    const names = extensions.map((extension) => fileName(stem, extension, collision));
    if (names.every((name) => !taken(name) && !taken(sidecarName(name)))) return collision;
  }
}
