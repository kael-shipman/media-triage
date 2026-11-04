// Which folder and file names a library limited by date includes (DESIGN.md, section 8).

export interface Day {
  year: number;
  month: number;
  day: number;
}

/** Parses "YYYY-MM-DD". */
export function parseDay(text: string): Day {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`"${text}" isn't a date written YYYY-MM-DD`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** The last year a name's leading four digits count as a year. Anything above is a number, not a date. */
export const LAST_YEAR = 2099;

/**
 * Whether a name, directly inside one of a library's dated levels, belongs in a library limited to names dated on or
 * after `since`. A name is allowed when it starts with:
 * - a year after since's (up to 2099), whatever follows; or
 * - since's year, then a later month (up to 12), separated ("2020.07", "2020-07") or not ("202007"); or
 * - since's year and month, then a day from since's to 31 ("2020.06.15", "2020-06-15", "20200615").
 * What follows the date doesn't matter. Everything else is excluded: earlier dates, undated names, and names only as
 * precise as a year or month that holds `since` ("2020 Christmas", "2020.06").
 *
 * src/core/exclusions.ts generates the exclusion patterns from this rule, and its tests check that they agree.
 */
export function allowedSince(name: string, since: Day): boolean {
  const year = /^(\d{4})/.exec(name);
  if (!year) return false;
  const value = Number(year[1]);
  if (value !== since.year) return value > since.year && value <= LAST_YEAR;

  const rest = name.slice(4);
  const separated = /^[.-](\d{2})(?:[.-](\d{2}))?/.exec(rest);
  const compact = /^(\d{2})(\d{2})?/.exec(rest);
  const parts = separated ?? compact;
  if (!parts) return false;
  const month = Number(parts[1]);
  if (month !== since.month) return month > since.month && month <= 12;
  if (parts[2] === undefined) return false;
  const day = Number(parts[2]);
  return day >= since.day && day <= 31;
}

/** Why a name isn't allowed: dated before `since`, not dated, or dated only by a year or month that holds `since`. */
export type Rejection = "before" | "undated" | "vague";

/** Why `allowedSince(name, since)` is false. Only meaningful for names it rejects. */
export function whyRejected(name: string, since: Day): Rejection {
  const year = /^(\d{4})/.exec(name);
  if (!year) return "undated";
  const value = Number(year[1]);
  if (value > LAST_YEAR) return "undated";
  if (value < since.year) return "before";
  const rest = name.slice(4);
  const parts = /^[.-](\d{2})(?:[.-](\d{2}))?/.exec(rest) ?? /^(\d{2})(\d{2})?/.exec(rest);
  if (!parts) return "vague";
  const month = Number(parts[1]);
  if (month > 12) return "undated";
  if (month < since.month) return "before";
  if (parts[2] === undefined) return "vague";
  const day = Number(parts[2]);
  return day > 31 ? "undated" : "before";
}

export type PathVerdict =
  /** Not inside any dated level: the date limit doesn't apply. */
  | { kind: "unlimited" }
  /** Inside a dated level, under an allowed name. */
  | { kind: "allowed"; name: string }
  /**
   * Excluded: under a rejected name, or "loose": a file directly in a folder above a level's "*" segment, which the
   * `*.*` pattern excludes. A folder there is never excluded, even with a dot in its name: fast-glob doesn't prune it,
   * and picomatch's `*` doesn't reach inside it.
   */
  | { kind: "rejected"; name: string; why: Rejection | "loose" };

/**
 * Where a path (Immich's) stands in a library limited by date, by the same rule its exclusion patterns are made from
 * (`datedExclusions`). Levels are folders whose entries are named with dates, and may hold "*" segments. Literal
 * segments are compared without regard to case, as Immich's matchers do. The first level that holds the path decides.
 */
export function classifyPath(path: string, levels: readonly string[], since: Day): PathVerdict {
  const segments = path.split("/");
  for (const level of levels) {
    const levelSegments = level.replace(/\/+$/, "").split("/");
    if (segments.length <= levelSegments.length - 1) continue;
    let inside = true;
    let loose: string | undefined;
    for (let index = 0; index < levelSegments.length && inside; index++) {
      const want = levelSegments[index]!;
      const have = segments[index];
      if (have === undefined) {
        inside = false;
      } else if (want.includes("*")) {
        // A file at this depth is loose: `*.*` matches it, since a media file has an extension.
        if (index === segments.length - 1) loose = have;
      } else if (want.toLowerCase() !== have.toLowerCase()) {
        inside = false;
      }
      if (loose !== undefined) break;
    }
    if (!inside) continue;
    if (loose !== undefined) return { kind: "rejected", name: loose, why: "loose" };
    const name = segments[levelSegments.length];
    if (name === undefined) continue;
    return allowedSince(name, since) ? { kind: "allowed", name } : { kind: "rejected", name, why: whyRejected(name, since) };
  }
  return { kind: "unlimited" };
}
