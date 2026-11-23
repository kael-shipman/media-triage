import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES } from "../../test/immich/harness.ts";
import { darktableReads, immichReads } from "../core/xmp.ts";
import { Exiftool } from "../sidecars/exiftool.ts";
import { readSidecar } from "../sidecars/sidecar.ts";
import { State } from "../state.ts";
import { renameProblem, renameTag, renamed } from "./rename-tag.ts";
import { SyncStore } from "./store.ts";

let exiftool: Exiftool;
beforeAll(async () => {
  exiftool = await Exiftool.start();
});
afterAll(async () => {
  await exiftool.close();
});

test("a tag is renamed with the tags under it, and nothing else", () => {
  expect(renamed("People/Old Name", "People/Old Name", "People/New Name")).toBe("People/New Name");
  expect(renamed("People/Old Name/Kids", "People/Old Name", "People/New Name")).toBe("People/New Name/Kids");
  expect(renamed("People/Old Names", "People/Old Name", "People/New Name")).toBe("People/Old Names");
  expect(renamed("Places/Lake", "People/Old Name", "People/New Name")).toBe("Places/Lake");
});

test("renames that can't be done", () => {
  expect(renameProblem("People/Old", "People/New")).toBeUndefined();
  expect(renameProblem("People/Old", "People/Old")).toContain("the same");
  expect(renameProblem("People/Old", "People/Old/Child")).toContain("under");
  expect(renameProblem("Title/Lake day", "Title/Other")).toContain("title");
  expect(renameProblem("People/Old", "Creator/Old")).toContain("creator");
  expect(renameProblem("People/Old", " People/New")).toContain("space");
  expect(renameProblem("People//Old", "People/New")).toContain("empty part");
});

test("rename-tag rewrites the sidecars the state knows have it, for both tools, keeping the title and creator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  const state = State.open(join(dir, "state"));
  try {
    const store = new SyncStore(state.db);
    const unit = join(dir, "photo.jpg");
    copyFileSync(join(FIXTURES, "photo.jpg"), unit);
    copyFileSync(join(FIXTURES, "darktable.xmp"), `${unit}.xmp`);
    const before = (await readSidecar(exiftool, `${unit}.xmp`))!.fields;
    expect(darktableReads(before).tags).toContain("People/Robin Example");
    const synced = { rating: 3, title: "Lake day", description: null, creator: "Alex Example", tags: darktableReads(before).tags, date: null, gps: null, trashed: false };
    store.putUnits([{ path: unit, synced, updated: "2026-11-22T00:00:00.000Z" }]);

    const dry = await renameTag(store, exiftool, "People/Robin Example", "People/Robin Renamed", { dryRun: true });
    expect(dry).toEqual({ renamed: [unit], changedMeanwhile: [] });
    const unchanged = readFileSync(`${unit}.xmp`, "utf8");
    expect(unchanged).toContain("Robin Example");

    const report = await renameTag(store, exiftool, "People/Robin Example", "People/Robin Renamed", { dryRun: false });
    expect(report).toEqual({ renamed: [unit], changedMeanwhile: [] });
    const after = (await readSidecar(exiftool, `${unit}.xmp`))!.fields;
    expect(darktableReads(after).tags).toEqual(darktableReads(before).tags.map((tag) => (tag === "People/Robin Example" ? "People/Robin Renamed" : tag)));
    expect(immichReads(after).tags).toContain("People/Robin Renamed");
    expect(immichReads(after).tags).not.toContain("People/Robin Example");
    expect(after.title).toBe(before.title);
    expect(after.creator).toEqual(before.creator);

    // Again: nothing left to rename.
    expect(await renameTag(store, exiftool, "People/Robin Example", "People/Robin Renamed", { dryRun: false })).toEqual({ renamed: [], changedMeanwhile: [] });
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
