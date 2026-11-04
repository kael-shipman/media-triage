// Immich exclusion patterns for a library limited by date (DESIGN.md, section 8).
//
// Immich has no "include" patterns, so the patterns must match every name `allowedSince` rejects, and none it
// allows. They're built from the same rule, prefix by prefix, and tested against picomatch and fast-glob, which
// Immich matches them with. Negated brackets are written "[^…]": picomatch reads "[!…]" as a literal "!".

import { type Day, LAST_YEAR, parseDay } from "./folder-dates.ts";

const pad = (value: number, width: number) => String(value).padStart(width, "0");
const range = (low: string, high: string) => (low === high ? low : `[${low}-${high}]`);

/**
 * Glob fragments matching exactly the `width`-digit, zero-padded numbers from `low` to `high`. For example,
 * 0 to 2018 with width 4 gives "[0-1][0-9][0-9][0-9]", "200[0-9]" and "201[0-8]".
 */
export function numberRange(low: number, high: number, width: number): string[] {
  if (low > high) return [];
  return split(pad(low, width), pad(high, width));
}

function split(low: string, high: string): string[] {
  if (low === "") return [""];
  if (low === high) return [low];
  const [first, last] = [low[0]!, high[0]!];
  const [lowRest, highRest] = [low.slice(1), high.slice(1)];
  if (first === last) return split(lowRest, highRest).map((tail) => first + tail);

  const any = "[0-9]".repeat(lowRest.length);
  const lowIsFloor = /^0*$/.test(lowRest);
  const highIsCeiling = /^9*$/.test(highRest);
  const fragments: string[] = [];
  let fullFrom = Number(first);
  let fullTo = Number(last);
  if (!lowIsFloor) {
    fragments.push(...split(lowRest, "9".repeat(lowRest.length)).map((tail) => first + tail));
    fullFrom++;
  }
  if (!highIsCeiling) fullTo--;
  if (fullFrom <= fullTo) fragments.push(range(String(fullFrom), String(fullTo)) + any);
  if (!highIsCeiling) fragments.push(...split("0".repeat(highRest.length), highRest).map((tail) => last + tail));
  return fragments;
}

/** Patterns for one path segment, matching every name `allowedSince(name, since)` rejects. */
export function rejectedNames(since: Day): string[] {
  const year = pad(since.year, 4);
  const month = pad(since.month, 2);
  const patterns: string[] = [
    // Not starting with a digit.
    "[^0-9]*",
    // One to three leading digits.
    "[0-9]",
    "[0-9][^0-9]*",
    "[0-9][0-9]",
    "[0-9][0-9][^0-9]*",
    "[0-9][0-9][0-9]",
    "[0-9][0-9][0-9][^0-9]*",
    // Four digits that aren't since's year or a later one.
    ...numberRange(0, since.year - 1, 4).map((years) => `${years}*`),
    ...numberRange(LAST_YEAR + 1, 9999, 4).map((years) => `${years}*`),
    // Since's year alone, or followed by something that isn't a month.
    year,
    `${year}[^0-9.-]*`,
  ];
  const rejectedMonths = [...numberRange(0, since.month - 1, 2), ...numberRange(13, 99, 2)];
  const rejectedDays = [...numberRange(0, since.day - 1, 2), ...numberRange(32, 99, 2)];
  // Separated ("2020.06.15", "2020-06-15") and compact ("20200615"); the separated forms mark where each part ends.
  for (const [separator, afterMonth] of [["[.-]", "[^.-]"], ["", "[^0-9]"]] as const) {
    const sep = separator;
    patterns.push(
      // An incomplete month.
      ...(sep ? [`${year}${sep}`, `${year}${sep}[^0-9]*`] : []),
      `${year}${sep}[0-9]`,
      `${year}${sep}[0-9][^0-9]*`,
      // An earlier or impossible month.
      ...rejectedMonths.map((months) => `${year}${sep}${months}*`),
      // Since's month, without a day.
      `${year}${sep}${month}`,
      `${year}${sep}${month}${afterMonth}*`,
      ...(sep ? [`${year}${sep}${month}${sep}`, `${year}${sep}${month}${sep}[^0-9]*`] : []),
      // Since's month, with an incomplete, earlier or impossible day.
      `${year}${sep}${month}${sep}[0-9]`,
      `${year}${sep}${month}${sep}[0-9][^0-9]*`,
      ...rejectedDays.map((days) => `${year}${sep}${month}${sep}${days}*`),
    );
  }
  return patterns;
}

/**
 * A library's exclusion patterns for its date limit. Each level is a folder (Immich's path, which may hold "*"
 * segments) whose entries are named with dates. Each rejected name is excluded with everything inside it. Files
 * directly in a folder above a level's "*" segment aren't under any dated name, so they're excluded too.
 */
export function datedExclusions(dated: { since: string; levels: string[] }): string[] {
  const names = rejectedNames(parseDay(dated.since));
  const patterns: string[] = [];
  for (const level of dated.levels) {
    const base = level.replace(/\/+$/, "");
    patterns.push(...names.map((name) => `${base}/${name}{,/**}`));
    const segments = base.split("/");
    segments.forEach((segment, index) => {
      // Files have an extension; the folders above a dated level (Clips, Productions, …) don't.
      if (segment.includes("*")) patterns.push(`${segments.slice(0, index).join("/")}/*.*`);
    });
  }
  return [...new Set(patterns)];
}

/** Immich's limit on a library's exclusion patterns. */
export const MAX_EXCLUSION_PATTERNS = 128;
