import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES } from "../../test/immich/harness.ts";
import { type AccountState, type XmpFields, darktableReads, immichReads } from "../core/xmp.ts";
import { Exiftool, ExiftoolMissing, findExiftool } from "./exiftool.ts";
import { createSidecar, readSidecar, stampOf, writeSidecar } from "./sidecar.ts";

let exiftool: Exiftool;
let dir: string;
beforeAll(async () => {
  exiftool = await Exiftool.start();
});
afterAll(() => exiftool.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A copy of a fixture sidecar, as `photo.jpg.xmp` beside a copy of the fixture photo. */
function copyOf(fixture: "darktable" | "immich"): string {
  copyFileSync(join(FIXTURES, "photo.jpg"), join(dir, "photo.jpg"));
  const path = join(dir, "photo.jpg.xmp");
  copyFileSync(join(FIXTURES, `${fixture}.xmp`), path);
  return path;
}

describe("finding exiftool", () => {
  test("the one on the PATH comes first", () => {
    expect(findExiftool({ which: () => "/usr/bin/exiftool" })).toEqual({ path: "/usr/bin/exiftool", source: "path" });
  });

  test("from source, the copy exiftool-vendored brings stands in", () => {
    expect(findExiftool({ which: () => null, compiled: false }).source).toBe("bundled");
  });

  test("a release never uses that copy, and says how to install exiftool", () => {
    expect(() => findExiftool({ which: () => null, compiled: true })).toThrow(/libimage-exiftool-perl/);
  });

  test("an exiftool that doesn't run is reported", async () => {
    const promise = Exiftool.start({ path: join(dir, "no-such-exiftool") });
    await expect(promise).rejects.toBeInstanceOf(ExiftoolMissing);
    await expect(promise).rejects.toThrow(/no-such-exiftool/);
  });

  test("it reports its version", () => {
    expect(exiftool.version).toMatch(/^\d+\.\d+/);
  });
});

describe("reading", () => {
  test("a sidecar Darktable wrote", async () => {
    const sidecar = (await readSidecar(exiftool, copyOf("darktable")))!;
    expect(sidecar.stamp).toEqual(stampOf(sidecar.path)!);
    expect(sidecar.fields).toEqual({
      toolkit: "XMP Core 4.4.0-Exiv2",
      rating: 3,
      title: "Lake day",
      description: "A day by the lake",
      creator: ["Alex Example"],
      subject: ["Lake", "People", "Places", "Robin Example", "darktable", "format", "jpg"],
      hierarchicalSubject: ["People|Robin Example", "Places|Lake", "darktable|format|jpg"],
      date: "2021:06:15 10:20:30.000",
      latitude: 12.5,
      longitude: -3.25,
    });
    expect(darktableReads(sidecar.fields).tags).toEqual(["People/Robin Example", "Places/Lake"]);
  });

  test("a sidecar Immich wrote: its own copies of the description and date, and TagsList", async () => {
    const sidecar = (await readSidecar(exiftool, copyOf("immich")))!;
    expect(sidecar.fields).toMatchObject({
      rating: 4,
      description: "A day by the lake",
      immichDescription: "A day by the lake",
      tagsList: ["Places/Lake"],
      date: "2021:06:15 10:20:30.000+02:00",
      immichDate: "2021:06:15 10:20:30.000+02:00",
      latitude: 12.5,
      longitude: -3.25,
    });
    expect(sidecar.fields.toolkit).toMatch(/ExifTool/);
    expect(immichReads(sidecar.fields)).toEqual({ tags: ["Places/Lake"], rating: 4, description: "A day by the lake", date: "2021:06:15 10:20:30.000+02:00" });
  });

  test("no file, no sidecar", async () => {
    expect(await readSidecar(exiftool, join(dir, "missing.jpg.xmp"))).toBeUndefined();
  });
});

describe("writing", () => {
  test("writes only what changes, and both tools then read what's wanted", async () => {
    const path = copyOf("darktable");
    chmodSync(path, 0o640);
    const sidecar = (await readSidecar(exiftool, path))!;
    const outcome = await writeSidecar(exiftool, sidecar, { rating: 5, tags: ["Places/Lake", "Music/AC|DC"], title: "Lake day" });
    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") return;
    expect(Object.keys(outcome.plan).sort()).toEqual(["XMP-dc:Subject", "XMP-lr:HierarchicalSubject", "XMP-xmp:Rating"]);
    expect(outcome.stamp).toEqual(stampOf(path)!);

    const after = (await readSidecar(exiftool, path))!;
    expect(darktableReads(after.fields)).toEqual({ ...darktableReads(sidecar.fields), rating: 5, tags: ["Places/Lake", "Music/AC|DC"] });
    expect(immichReads(after.fields).tags).toEqual(["Places/Lake", "Music/AC|DC"]);
    expect(after.fields.hierarchicalSubject).toContain("darktable|format|jpg");
    expect(after.fields.toolkit).toMatch(/ExifTool/);
    // Darktable's own fields are untouched, the permissions kept, and there's no backup beside it.
    expect(readFileSync(path, "utf8")).toContain("darktable:history");
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir).sort()).toEqual(["photo.jpg", "photo.jpg.xmp"]);
  });

  test("nothing to change, nothing written", async () => {
    const path = copyOf("darktable");
    const sidecar = (await readSidecar(exiftool, path))!;
    expect(await writeSidecar(exiftool, sidecar, { rating: 3, tags: ["Places/Lake", "People/Robin Example"], date: "2021:06:15 10:20:30" })).toEqual({ status: "unchanged" });
    expect(stampOf(path)).toEqual(sidecar.stamp);
  });

  test("a file that changed since it was read is left alone", async () => {
    const path = copyOf("darktable");
    const sidecar = (await readSidecar(exiftool, path))!;
    writeFileSync(path, readFileSync(path, "utf8").replace('xmp:Rating="3"', 'xmp:Rating="1"'));
    const before = readFileSync(path, "utf8");
    expect((await writeSidecar(exiftool, sidecar, { rating: 5 })).status).toBe("changed-meanwhile");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a dry run says what it would write, and writes nothing", async () => {
    const path = copyOf("darktable");
    const sidecar = (await readSidecar(exiftool, path))!;
    expect(await writeSidecar(exiftool, sidecar, { rating: 5 }, { dryRun: true })).toEqual({ status: "dry-run", plan: { "XMP-xmp:Rating": 5 } });
    expect(stampOf(path)).toEqual(sidecar.stamp);
  });

  test("Immich's copies of the description and date follow, keeping the date's offset", async () => {
    const path = copyOf("immich");
    const sidecar = (await readSidecar(exiftool, path))!;
    await writeSidecar(exiftool, sidecar, { description: "Changed", date: "2021:06:16 08:00:00" });
    const after = (await readSidecar(exiftool, path))!;
    expect(immichReads(after.fields)).toMatchObject({ description: "Changed", date: "2021:06:16 08:00:00+02:00" });
    expect(darktableReads(after.fields)).toMatchObject({ description: "Changed", date: "2021:06:16 08:00:00" });
  });

  test("awkward values come back exactly as written", async () => {
    const path = copyOf("darktable");
    const accounts: AccountState[] = [
      { user: "8a1b", favorite: true, visibility: "archive", albums: [{ id: "a1", name: "Trip, 2020 [part {1}] | a=b" }, { id: "a2", name: "Ünïcödé & <more>" }] },
      { user: "9c2d", favorite: false, visibility: "locked", albums: [] },
    ];
    const regions = {
      width: 1440,
      height: 1080,
      regions: [{ area: { x: 0.0972222, y: 0.087963, w: 0.0555556, h: 0.101852 }, type: "Face", name: "Robin Example, Jr." }],
    };
    const wanted = {
      title: "1.50",
      description: "Two lines,\nwith <markup> & a tab\there",
      creator: "Zoë Example",
      tags: ["007", "Music/AC|DC", "People/Robin Example, Jr.", "Places/Lake {north}"],
      date: "2021:06:15 23:59:59.123-05:00",
      gps: { latitude: -33.8567844, longitude: 151.213108 },
      accounts,
      regions,
    };
    await writeSidecar(exiftool, (await readSidecar(exiftool, path))!, wanted);
    const after = (await readSidecar(exiftool, path))!;
    const fields: XmpFields = after.fields;
    expect(fields.title).toBe("1.50");
    expect(fields.description).toBe(wanted.description);
    expect(fields.creator).toEqual(["Zoë Example"]);
    expect(darktableReads(fields).tags).toEqual(wanted.tags);
    expect(fields.date).toBe("2021:06:15 23:59:59.123-05:00");
    expect(fields.latitude).toBeCloseTo(wanted.gps.latitude, 7);
    expect(fields.longitude).toBeCloseTo(wanted.gps.longitude, 7);
    expect(fields.accounts).toEqual(accounts);
    expect(fields.regions!.regions[0]!.area).toEqual(regions.regions[0]!.area);
    expect(fields.regions!.regions[0]!.name).toBe("Robin Example, Jr.");
    // Read back, it's all the same: nothing more to write.
    expect(await writeSidecar(exiftool, after, wanted)).toEqual({ status: "unchanged" });
  });

  test("removing values", async () => {
    const path = copyOf("immich");
    await writeSidecar(exiftool, (await readSidecar(exiftool, path))!, { tags: [], description: null, gps: null, rating: null });
    const { fields } = (await readSidecar(exiftool, path))!;
    for (const key of ["tagsList", "hierarchicalSubject", "subject", "description", "immichDescription", "latitude", "longitude", "rating"] as const) {
      expect(fields[key]).toBeUndefined();
    }
  });
});

describe("minimal sidecars (F2)", () => {
  test("a new sidecar holds only the creator, and nothing else is left behind", async () => {
    const photo = join(dir, "PXL_20210615_102030.jpg");
    copyFileSync(join(FIXTURES, "photo.jpg"), photo);
    const outcome = await createSidecar(exiftool, photo, "Alex Example");
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") return;
    expect(outcome.sidecar.path).toBe(`${photo}.xmp`);
    expect(outcome.sidecar.fields).toEqual({ toolkit: expect.stringMatching(/ExifTool/), creator: ["Alex Example"] });
    expect(readdirSync(dir).sort()).toEqual(["PXL_20210615_102030.jpg", "PXL_20210615_102030.jpg.xmp"]);
  });

  test("an existing sidecar is never replaced", async () => {
    const path = copyOf("darktable");
    const before = readFileSync(path, "utf8");
    expect(await createSidecar(exiftool, join(dir, "photo.jpg"), "Sam Example")).toEqual({ status: "exists" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a dry run creates nothing", async () => {
    const photo = join(dir, "photo.jpg");
    copyFileSync(join(FIXTURES, "photo.jpg"), photo);
    expect(await createSidecar(exiftool, photo, "Alex Example", { dryRun: true })).toEqual({ status: "dry-run", path: `${photo}.xmp` });
    expect(readdirSync(dir)).toEqual(["photo.jpg"]);
  });
});
