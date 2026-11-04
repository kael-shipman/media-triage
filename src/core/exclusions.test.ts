// The patterns must agree exactly with allowedSince, in every matcher Immich uses: picomatch (its file watcher, with
// dot: true, and its check of existing assets, with nocase: true) and fast-glob (its crawler).
import { afterAll, describe, expect, test } from "bun:test";
import fastGlob from "fast-glob";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import picomatch from "picomatch";
import { MAX_EXCLUSION_PATTERNS, datedExclusions, numberRange, rejectedNames } from "./exclusions.ts";
import { allowedSince, parseDay } from "./folder-dates.ts";

/** A deterministic pseudo-random generator (mulberry32), so failures reproduce. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Names around a cutover: dates in every format, near it and far from it, plus junk. */
function namesAround(sinceText: string, count: number, seed: number): string[] {
  const since = parseDay(sinceText);
  const next = random(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  const two = (value: number) => String(value).padStart(2, "0");
  const names = new Set<string>(["Staging", "Highlights", "Misc", "Summer Fair", "1", "12", "123", "1234", "2100", "0000"]);
  for (let i = 0; i < count; i++) {
    const year = pick([since.year - 1, since.year, since.year, since.year, since.year + 1, 1999, 2099, 2100, 1000 + Math.floor(next() * 9000)]);
    const month = pick([since.month - 1, since.month, since.month, since.month + 1, 0, 12, 13, 99, Math.floor(next() * 100)]);
    const day = pick([since.day - 1, since.day, since.day + 1, 0, 1, 31, 32, 99, Math.floor(next() * 100)]);
    const sep = pick([".", "-", ""]);
    const sep2 = pick([".", "-", "", sep, sep]);
    const tail = pick(["", " - Title", " x", "_120000", "5", ".", "-", "a", "..", " ", "0"]);
    const shape = pick(["ymd", "ymd", "ymd", "ym", "y", "junk"]);
    const y = String(year).padStart(4, "0");
    if (shape === "ymd") names.add(`${y}${sep}${two(month)}${sep2}${two(day)}${tail}`);
    if (shape === "ym") names.add(`${y}${sep}${two(month)}${tail}`);
    if (shape === "y") names.add(`${y}${tail}`);
    if (shape === "junk") names.add(Array.from({ length: 1 + Math.floor(next() * 10) }, () => pick(["0", "1", "2", "9", ".", "-", " ", "a", "_"])).join(""));
  }
  // Hidden names are excluded separately (**/.*), and a name can't hold "/".
  return [...names].filter((name) => name !== "" && !name.startsWith("."));
}

describe("numberRange", () => {
  test("a known example", () => {
    expect(numberRange(0, 2018, 4)).toEqual(["[0-1][0-9][0-9][0-9]", "200[0-9]", "201[0-8]"]);
    expect(numberRange(5, 4, 2)).toEqual([]);
  });

  test("matches exactly the numbers in range, for every two-digit range", () => {
    for (let low = 0; low < 100; low++) {
      for (let high = low; high < 100; high++) {
        const matcher = picomatch(numberRange(low, high, 2));
        for (let n = 0; n < 100; n++) expect([n, matcher(String(n).padStart(2, "0"))]).toEqual([n, n >= low && n <= high]);
      }
    }
  });

  test("and for random three- and four-digit ranges", () => {
    const next = random(7);
    for (let round = 0; round < 200; round++) {
      const width = round % 2 ? 3 : 4;
      const max = 10 ** width;
      const [low, high] = [Math.floor(next() * max), Math.floor(next() * max)].sort((a, b) => a - b) as [number, number];
      const matcher = picomatch(numberRange(low, high, width));
      for (let k = 0; k < 300; k++) {
        const n = Math.floor(next() * max);
        expect([low, high, n, matcher(String(n).padStart(width, "0"))]).toEqual([low, high, n, n >= low && n <= high]);
      }
    }
  });
});

describe.each(["2020-06-15", "2020-01-01", "2021-12-31", "2019-10-09", "2000-02-01", "2015-11-30"])("since %s", (since) => {
  const levels = ["/m/Pictures", "/m/Videos/*"];
  const patterns = datedExclusions({ since, levels });
  const names = namesAround(since, 3000, since.length * 31 + Number(since.slice(-2)));

  test("stays well within Immich's limit", () => {
    expect(patterns.length).toBeLessThanOrEqual(MAX_EXCLUSION_PATTERNS - 20);
  });

  test("the generated names cover both sides of the rule", () => {
    const allowed = names.filter((name) => allowedSince(name, parseDay(since))).length;
    expect(allowed).toBeGreaterThan(names.length * 0.1);
    expect(names.length - allowed).toBeGreaterThan(names.length * 0.1);
  });

  test.each([
    ["the watcher (dot: true)", { dot: true }],
    ["the asset check (nocase: true)", { nocase: true }],
    ["defaults", {}],
  ])("agrees with allowedSince in picomatch: %s", (_, options) => {
    const excluded = picomatch(patterns, options);
    for (const name of names) {
      const allowed = allowedSince(name, parseDay(since));
      for (const path of [`/m/Pictures/${name}`, `/m/Pictures/${name}/a.jpg`, `/m/Pictures/${name}/sub/b.jpg`, `/m/Videos/Clips/${name}/c.mp4`]) {
        expect([path, excluded(path)]).toEqual([path, !allowed]);
      }
    }
  });

  test("leaves the folders above a dated level alone, but excludes files directly in them", () => {
    const excluded = picomatch(patterns, { dot: true });
    expect(excluded("/m/Videos/Clips")).toBe(false);
    expect(excluded("/m/Videos/Old Clips")).toBe(false);
    expect(excluded("/m/Videos/loose clip.mp4")).toBe(true);
    expect(excluded("/m/Pictures")).toBe(false);
  });
});

describe("the crawler (fast-glob, as Immich calls it)", () => {
  const root = mkdtempSync(join(tmpdir(), "media-triage-crawl-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const since = "2020-06-15";
  const names = namesAround(since, 400, 99).filter((name) => !/[*?[\]{}()!\\]/.test(name));
  for (const name of names) {
    mkdirSync(join(root, "Pictures", name, "sub"), { recursive: true });
    writeFileSync(join(root, "Pictures", name, "sub", "a.jpg"), "");
    mkdirSync(join(root, "Videos", "Clips", name), { recursive: true });
    writeFileSync(join(root, "Videos", "Clips", name, "b.MP4"), "");
  }
  writeFileSync(join(root, "Videos", "loose.mp4"), "");

  test("finds exactly the allowed files", async () => {
    const patterns = datedExclusions({ since, levels: [join(root, "Pictures"), join(root, "Videos/*")] });
    const found = await fastGlob([`${root}/Pictures/**/*.{jpg,mp4}`, `${root}/Videos/**/*.{jpg,mp4}`], {
      absolute: true,
      caseSensitiveMatch: false,
      onlyFiles: true,
      dot: false,
      ignore: patterns,
    });
    const expected = names
      .filter((name) => allowedSince(name, parseDay(since)))
      .flatMap((name) => [join(root, "Pictures", name, "sub", "a.jpg"), join(root, "Videos", "Clips", name, "b.MP4")]);
    expect(expected.length).toBeGreaterThan(50);
    expect(found.sort()).toEqual(expected.sort());
  });
});

test("one level's rejected names, for the record", () => {
  expect(rejectedNames(parseDay("2020-06-15"))).toMatchSnapshot();
});
