// The other two programs that write sidecars, Immich and Darktable, must keep what only the daemon writes: its own
// namespace (F9) and face regions (F10). Each test gives a copy of a sidecar the daemon's fields, has the other
// program rewrite it the way it does when someone edits the photo, and reads it back.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { darktable, describeDarktable } from "../../test/darktable.ts";
import { FIXTURES, USERS, api, describeImmich, indexedLibrary, login, newUser, waitFor } from "../../test/immich/harness.ts";
import { type AccountState, type Wanted, darktableReads, immichReads, sameDate } from "../core/xmp.ts";
import { Exiftool } from "./exiftool.ts";
import { readSidecar, writeSidecar } from "./sidecar.ts";

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

const accounts: AccountState[] = [
  { user: "4f1c2d3e-0000-4000-8000-000000000001", favorite: true, visibility: "archive", albums: [{ id: "a1", name: "Lake, 2021 [summer]" }] },
  { user: "4f1c2d3e-0000-4000-8000-000000000002", favorite: false, visibility: "timeline", albums: [{ id: "a2", name: "Robin" }] },
];
const regions = {
  width: 96,
  height: 64,
  regions: [{ area: { x: 0.25, y: 0.5, w: 0.2, h: 0.3 }, type: "Face", name: "Robin Example" }],
};
const ours: Wanted = { accounts, regions };

/** A copy of a fixture sidecar beside a copy of the photo, with the daemon's fields added. Returns the photo. */
async function photoWithOurFields(folder: string, fixture: "darktable" | "immich", name = "photo.jpg"): Promise<string> {
  const photo = join(folder, name);
  copyFileSync(join(FIXTURES, "photo.jpg"), photo);
  copyFileSync(join(FIXTURES, `${fixture}.xmp`), `${photo}.xmp`);
  const outcome = await writeSidecar(exiftool, (await readSidecar(exiftool, `${photo}.xmp`))!, ours);
  expect(outcome.status).toBe("written");
  return photo;
}

/** The daemon's fields, unchanged. */
function expectOurs(fields: Awaited<ReturnType<typeof readSidecar>>): void {
  expect(fields!.fields.accounts).toEqual(accounts);
  expect(fields!.fields.regions!.width).toBe(96);
  expect(fields!.fields.regions!.height).toBe(64);
  expect(fields!.fields.regions!.regions.map(({ area, type, name }) => ({ area, type, name }))).toEqual(regions.regions);
}

describeDarktable("Darktable keeps the daemon's fields", () => {
  test("when it rewrites its own sidecar", async () => {
    const photo = await photoWithOurFields(dir, "darktable");
    const before = (await readSidecar(exiftool, `${photo}.xmp`))!;
    await darktable(photo, "  image.rating = 1");
    const after = (await readSidecar(exiftool, `${photo}.xmp`))!;
    expect(after.fields.toolkit).toMatch(/Exiv2/);
    expect(darktableReads(after.fields)).toEqual({ ...darktableReads(before.fields), rating: 1 });
    expectOurs(after);
  });

  test("when it rewrites one Immich wrote: Immich's copies stay, and its date loses the offset", async () => {
    const photo = await photoWithOurFields(dir, "immich");
    const before = (await readSidecar(exiftool, `${photo}.xmp`))!;
    await darktable(photo, "  image.rating = 2");
    const after = (await readSidecar(exiftool, `${photo}.xmp`))!;
    expect(after.fields.toolkit).toMatch(/Exiv2/);
    expectOurs(after);
    expect(after.fields).toMatchObject({ rating: 2, tagsList: ["Places/Lake"], immichDescription: "A day by the lake", immichDate: before.fields.immichDate! });
    // Darktable keeps the wall time, and drops the offset (DESIGN.md, F6).
    expect(after.fields.date).toBe("2021:06:15 10:20:30.000");
    expect(sameDate(after.fields.date, before.fields.date)).toBe(true);
    // It reads the tags from its own fields, which Immich's sidecar doesn't have.
    expect(darktableReads(after.fields).tags).toEqual([]);
    expect(immichReads(after.fields)).toEqual({ ...immichReads(before.fields), rating: 2 });
  });
});

describeDarktable("a capture time changed in Darktable", () => {
  test("reaches Immich's field with its zone, and a later Darktable write needs nothing more", async () => {
    const photo = join(dir, "photo.jpg");
    copyFileSync(join(FIXTURES, "photo.jpg"), photo);
    copyFileSync(join(FIXTURES, "immich.xmp"), `${photo}.xmp`);
    await darktable(photo, '  image.exif_datetime_taken = "2021:06:15 11:45:00"');
    const moved = (await readSidecar(exiftool, `${photo}.xmp`))!;
    expect(darktableReads(moved.fields).date).toMatch(/^2021:06:15 11:45:00/);
    expect(immichReads(moved.fields).date).toBe("2021:06:15 10:20:30.000+02:00");

    // What the reconcile does with Darktable's change.
    expect((await writeSidecar(exiftool, moved, { date: darktableReads(moved.fields).date! })).status).toBe("written");
    const synced = (await readSidecar(exiftool, `${photo}.xmp`))!;
    expect(immichReads(synced.fields).date).toMatch(/^2021:06:15 11:45:00(\.000)?\+02:00$/);
    expect(sameDate(darktableReads(synced.fields).date, immichReads(synced.fields).date)).toBe(true);

    // Darktable writes again (dropping the offset from its own field): nothing more to write.
    await darktable(photo, "  image.rating = 3");
    const again = (await readSidecar(exiftool, `${photo}.xmp`))!;
    expect(again.fields.date).toMatch(/^2021:06:15 11:45:00(\.000)?$/);
    expect(await writeSidecar(exiftool, again, { date: darktableReads(again.fields).date! })).toEqual({ status: "unchanged" });
  });
});

describeImmich("Immich keeps the daemon's fields", () => {
  test("when it rewrites a sidecar Darktable wrote", async () => {
    const alex = await login(USERS.alex);
    const owner = await newUser(alex.accessToken, "Writer");
    const session = await login(owner);
    let sidecar = "";
    const library = await indexedLibrary("writers", { token: alex.accessToken }, { token: session.accessToken, userId: session.userId }, ["photo.jpg"], {
      prepare: async (folder) => {
        sidecar = `${await photoWithOurFields(folder.local, "darktable")}.xmp`;
      },
    });
    const asset = library.assets["photo.jpg"]!;
    const before = (await readSidecar(exiftool, sidecar))!;

    await api("PUT", `/assets/${asset.id}`, { token: session.accessToken, body: { rating: 5 } });
    const after = await waitFor("Immich's sidecar write", async () => {
      const read = await readSidecar(exiftool, sidecar);
      return read?.fields.rating === 5 ? read : undefined;
    });

    expect(after.fields.toolkit).toMatch(/ExifTool/);
    expectOurs(after);
    expect(darktableReads(after.fields)).toEqual({ ...darktableReads(before.fields), rating: 5 });
    expect(readFileSync(sidecar, "utf8")).toContain("darktable:history");
  });
});
