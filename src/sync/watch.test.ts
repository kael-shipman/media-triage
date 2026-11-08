import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config.ts";
import { State } from "../state.ts";
import { stampOf } from "../sidecars/sidecar.ts";
import { coveredFolders, unitOf, watchWarning } from "./covered.ts";
import { fullPass } from "./full-pass.ts";
import { handleOrphans } from "./orphans.ts";
import { SyncStore } from "./store.ts";
import { DirtyUnits, Watcher } from "./watcher.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function touch(path: string, text = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("covered folders: libraries' folders through the path map, and the inbox's sources, none inside another", () => {
  const config = parseConfig(
    {
      paths: { inbox: "/media/Inbox", archive: "/media", state: dir },
      sources: [{ folder: "Alex Phone", creator: "Alex Example" }],
      immich: {
        path_map: [{ immich: "/mnt/media/", local: "/media/" }],
        accounts: [{ name: "alex", email: "alex@example.com", admin: true }],
        libraries: [
          { account: "alex", name: "Archive", folders: ["/mnt/media/Pictures", "/mnt/media/Videos", "/elsewhere/Photos"] },
          { account: "alex", name: "Inbox", folders: ["/mnt/media/Inbox"] },
          { account: "alex", name: "Clips", folders: ["/mnt/media/Videos/Clips"] },
        ],
      },
    },
    null,
  );
  expect(coveredFolders(config)).toEqual({ folders: ["/media/Inbox", "/media/Pictures", "/media/Videos"], unmapped: ["/elsewhere/Photos"] });
});

test.each([
  ["/a/photo.jpg", "/a/photo.jpg"],
  ["/a/photo.JPG.xmp", "/a/photo.JPG"],
  ["/a/clip.mp4", "/a/clip.mp4"],
  ["/a/photo.xmp", undefined],
  ["/a/photo_01.jpg.xmp", undefined],
  ["/a/notes.txt", undefined],
  ["/a/.photo.jpg.media-triage-1-abc.xmp", undefined],
  ["/a/photo.jpg.xmp_exiftool_tmp", undefined],
  ["/a/photo.jpg.sync-conflict-20261103-101010-ABCDEFG.xmp", undefined],
])("unitOf(%p) is %p", (path, unit) => {
  expect(unitOf(path)).toBe(unit);
});

test("the watch allowance is fine with room to spare, and says how to raise it otherwise", () => {
  expect(watchWarning(1000, 8192)).toBeUndefined();
  expect(watchWarning(5000, 8192)).toContain("fs.inotify.max_user_watches=32768");
  expect(watchWarning(5000, undefined)).toBeUndefined();
});

test("the watcher reports each change as its unit, in new folders too", async () => {
  const seen = new Set<string>();
  const watcher = new Watcher([dir], (unit) => seen.add(unit));
  try {
    await Bun.sleep(100);
    touch(join(dir, "Pictures", "a.jpg"));
    touch(join(dir, "Pictures", "New", "Deeper", "b.jpg.xmp"));
    touch(join(dir, "Pictures", "notes.txt"));
    for (let i = 0; i < 40 && seen.size < 2; i++) await Bun.sleep(50);
    expect([...seen].sort()).toEqual([join(dir, "Pictures", "New", "Deeper", "b.jpg"), join(dir, "Pictures", "a.jpg")]);
  } finally {
    watcher.close();
  }
});

test("dirty units are taken once they've been quiet", () => {
  let now = 0;
  const dirty = new DirtyUnits(() => now);
  dirty.add("/a.jpg");
  now = 500;
  dirty.add("/b.jpg");
  now = 1000;
  expect(dirty.take(1000)).toEqual({ units: ["/a.jpg"], nextInMs: 500 });
  now = 1500;
  expect(dirty.take(1000)).toEqual({ units: ["/b.jpg"], nextInMs: undefined });
  expect(dirty.size).toBe(0);
});

test("dirty units are taken a limited number at a time", () => {
  let now = 0;
  const dirty = new DirtyUnits(() => now);
  for (const name of ["/a.jpg", "/b.jpg", "/c.jpg"]) dirty.add(name);
  now = 1000;
  expect(dirty.take(1000, 2)).toEqual({ units: ["/a.jpg", "/b.jpg"], nextInMs: 0 });
  expect(dirty.take(1000, 2)).toEqual({ units: ["/c.jpg"], nextInMs: undefined });
});

test("the full pass returns units without a record, or whose sidecar changed", async () => {
  const state = State.open(join(dir, "state"));
  const store = new SyncStore(state.db);
  const root = join(dir, "media");
  for (const name of ["a.jpg", "a.jpg.xmp", "b.jpg", "c.mp4", "c.mp4.xmp", "notes.txt", ".hidden.jpg"]) touch(join(root, "x", name));
  touch(join(root, ".hidden", "d.jpg"));
  const synced = { rating: null, title: null, description: null, creator: null, tags: [], date: null, gps: null, trashed: false };
  const updated = "2026-11-04T00:00:00.000Z";
  store.putUnits([
    { path: join(root, "x", "a.jpg"), sidecar: stampOf(join(root, "x", "a.jpg.xmp")), synced, updated },
    { path: join(root, "x", "b.jpg"), synced, updated },
    { path: join(root, "x", "c.mp4"), sidecar: stampOf(join(root, "x", "c.mp4.xmp")), synced, updated },
  ]);
  expect(await fullPass(store, [root])).toEqual({ media: 3, changed: [], orphans: [], conflicts: [] });

  touch(join(root, "x", "a.jpg.xmp"), "changed");
  touch(join(root, "x", "b.jpg.xmp"));
  touch(join(root, "x", "new.heic"));
  expect(await fullPass(store, [root])).toEqual({
    media: 4,
    changed: [join(root, "x", "a.jpg"), join(root, "x", "b.jpg"), join(root, "x", "new.heic")],
    orphans: [],
    conflicts: [],
  });
  state.close();
});

test("the full pass counts a link to a file as a file, as Immich does, but doesn't enter a linked folder", async () => {
  const state = State.open(join(dir, "state"));
  const store = new SyncStore(state.db);
  const root = join(dir, "media");
  touch(join(root, "logos", "a", "logo.gif"));
  touch(join(root, "elsewhere", "b.jpg"));
  mkdirSync(join(root, "logos", "all"));
  symlinkSync("../a/logo.gif", join(root, "logos", "all", "logo.gif"));
  touch(join(root, "logos", "all", "logo.gif.xmp"));
  symlinkSync("../missing.gif", join(root, "logos", "all", "broken.gif"));
  symlinkSync("../elsewhere", join(root, "logos", "linked"));
  // The linked file's sidecar has its media file beside it: not an orphan.
  expect(await fullPass(store, [root])).toEqual({
    media: 3,
    changed: [join(root, "elsewhere", "b.jpg"), join(root, "logos", "a", "logo.gif"), join(root, "logos", "all", "logo.gif")],
    orphans: [],
    conflicts: [],
  });
  state.close();
});

test("orphan sidecars: never seen is reported, seen and gone waits out the grace period, then it's deleted (F11)", async () => {
  const state = State.open(join(dir, "state"));
  const store = new SyncStore(state.db);
  const folder = join(dir, "media", "x");
  const at = (name: string) => join(folder, name);
  const synced = { rating: null, title: null, description: null, creator: null, tags: [], date: null, gps: null, trashed: false };
  const updated = "2026-11-04T00:00:00.000Z";
  // Seen: gone.jpg (with a duplicate's sidecar too) and clip.mp4 (a "<stem>.xmp"); never seen: early.mov's; kept:
  // the sidecar of a file that's there; reported: a conflict copy.
  for (const name of ["gone.jpg.xmp", "gone_01.jpg.xmp", "clip.xmp", "early.mov.xmp", "here.jpg", "here.jpg.xmp", "here.jpg.sync-conflict-20261104-101010-ABCDEFG.xmp"]) {
    touch(at(name));
  }
  store.putUnits([at("gone.jpg"), at("clip.mp4"), at("here.jpg")].map((path) => ({ path, synced, updated })));
  const pass = await fullPass(store, [join(dir, "media")]);
  expect(pass.orphans).toEqual([at("clip.xmp"), at("early.mov.xmp"), at("gone.jpg.xmp"), at("gone_01.jpg.xmp")]);
  expect(pass.conflicts).toEqual([at("here.jpg.sync-conflict-20261104-101010-ABCDEFG.xmp")]);

  const hour = 60 * 60_000;
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  const first = handleOrphans(store, pass.orphans, { graceMs: hour, now, dryRun: false });
  expect(first).toEqual({ deleted: [], waiting: [at("clip.xmp"), at("gone.jpg.xmp"), at("gone_01.jpg.xmp")], unknown: [at("early.mov.xmp")] });
  expect(store.unit(at("gone.jpg"))?.gone).toBe("2026-11-04T12:00:00.000Z");

  expect(handleOrphans(store, pass.orphans, { graceMs: hour, now: now + hour - 1, dryRun: false }).deleted).toEqual([]);
  expect(handleOrphans(store, pass.orphans, { graceMs: hour, now: now + hour, dryRun: true }).deleted).toHaveLength(3);
  expect(existsSync(at("gone.jpg.xmp"))).toBe(true);

  const last = handleOrphans(store, pass.orphans, { graceMs: hour, now: now + hour, dryRun: false });
  expect(last.deleted).toEqual([at("clip.xmp"), at("gone.jpg.xmp"), at("gone_01.jpg.xmp")]);
  expect(last.unknown).toEqual([at("early.mov.xmp")]);
  for (const name of ["clip.xmp", "gone.jpg.xmp", "gone_01.jpg.xmp"]) expect(existsSync(at(name))).toBe(false);
  expect(existsSync(at("early.mov.xmp"))).toBe(true);
  expect(store.unit(at("gone.jpg"))).toBeUndefined();
  state.close();
});

test("a media file that's back is reconciled again, and isn't gone any more", async () => {
  const state = State.open(join(dir, "state"));
  const store = new SyncStore(state.db);
  const path = join(dir, "media", "back.jpg");
  touch(path);
  const synced = { rating: null, title: null, description: null, creator: null, tags: [], date: null, gps: null, trashed: false };
  store.putUnits([{ path, synced, updated: "2026-11-04T00:00:00.000Z", gone: "2026-11-04T01:00:00.000Z" }]);
  expect((await fullPass(store, [join(dir, "media")])).changed).toEqual([path]);
  state.close();
});
