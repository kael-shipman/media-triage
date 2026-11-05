import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FIXTURES } from "../../test/immich/harness.ts";
import { parseConfig } from "../config.ts";
import { Exiftool } from "../sidecars/exiftool.ts";
import { readSidecar } from "../sidecars/sidecar.ts";
import { State } from "../state.ts";
import type { ReadyUnit, ReconcileContext, Refreshing } from "../sync/reconcile.ts";
import { SyncStore } from "../sync/store.ts";
import { fileBatch, finishPlanned } from "./file.ts";
import { FilingStore } from "./store.ts";

let exiftool: Exiftool;
let dir: string;
let state: State;
let ctx: ReconcileContext;
beforeAll(async () => {
  exiftool = await Exiftool.start();
});
afterAll(() => exiftool.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  state = State.open(join(dir, "state"));
  const config = parseConfig({ paths: { inbox: join(dir, "Inbox"), archive: dir, state: join(dir, "state") }, sources: [{ folder: "Phone", creator: "Alex Example" }] }, null);
  ctx = { config, store: new SyncStore(state.db), exiftool, accounts: new Map(), dryRun: false, refreshing: new Map<string, Refreshing>() };
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

const synced = { rating: 3, title: "Lake day", description: null, creator: "Alex Example", tags: ["Promote"], date: "2021:06:15 10:20:30", gps: null, trashed: false, people: ["People/Kit Example"] };
const folder = () => join(dir, "Pictures", "2021.06.15 - Lake day");

/** A photo in the inbox, tagged Promote in its sidecar, with a sync record, ready to file. */
async function readyPhoto(name: string): Promise<ReadyUnit> {
  const unit = join(dir, "Inbox", "Phone", name);
  mkdirSync(dirname(unit), { recursive: true });
  copyFileSync(join(FIXTURES, "photo.jpg"), unit);
  copyFileSync(join(FIXTURES, "darktable.xmp"), `${unit}.xmp`);
  const before = (await readSidecar(exiftool, `${unit}.xmp`))!;
  await exiftool.write(`${unit}.xmp`, { "XMP-lr:HierarchicalSubject": [...(before.fields.hierarchicalSubject ?? []), "Promote"] });
  const sidecar = (await readSidecar(exiftool, `${unit}.xmp`))!;
  ctx.store.putUnits([{ path: unit, sidecar: sidecar.stamp, synced, updated: "2026-11-04T00:00:00.000Z" }]);
  return { unit, sidecar, title: "Lake day", creator: "Alex Example", date: "2021:06:15 10:20:30", copies: [] };
}

test("a batch is moved: the files under their new names, Promote out of the sidecar, the record carried over", async () => {
  const [one, two] = [await readyPhoto("IMG_1.jpg"), await readyPhoto("IMG_2.jpg")];
  const report = await fileBatch(ctx, [one, two]);
  const [first, second] = [join(folder(), "2021.06.15-10.20.30 - Alex Example.jpg"), join(folder(), "2021.06.15-10.20.30 - Alex Example_01.jpg")];
  expect(report).toEqual({ filed: [{ unit: one.unit, destination: first }, { unit: two.unit, destination: second }], problems: [] });
  for (const path of [one.unit, `${one.unit}.xmp`, two.unit]) expect(existsSync(path)).toBe(false);
  for (const path of [first, `${first}.xmp`, second, `${second}.xmp`]) expect(existsSync(path)).toBe(true);

  const fields = (await readSidecar(exiftool, `${first}.xmp`))!.fields;
  expect(fields.hierarchicalSubject).not.toContain("Promote");
  expect(fields.title).toBe("Lake day");
  expect(ctx.store.unit(one.unit)).toBeUndefined();
  expect(ctx.store.unit(first)).toMatchObject({ synced: { people: ["People/Kit Example"] }, sidecar: { ino: statSync(`${first}.xmp`).ino } });
  expect(new FilingStore(state.db).get(one.unit)).toMatchObject({ status: "restoring", destination: first });
  expect(ctx.store.isBeingPutBack(first)).toBe(true);
});

test("a dry run plans and moves nothing", async () => {
  const one = await readyPhoto("IMG_1.jpg");
  const report = await fileBatch({ ...ctx, dryRun: true }, [one]);
  expect(report.filed).toHaveLength(1);
  expect(existsSync(one.unit)).toBe(true);
  expect(new FilingStore(state.db).get(one.unit)).toBeUndefined();
});

test("a filing cut short is finished; one whose new name is another file waits for a person", async () => {
  const one = await readyPhoto("IMG_1.jpg");
  const destination = join(folder(), "2021.06.15-10.20.30 - Alex Example.jpg");
  const moves = [
    { from: one.unit, to: destination },
    { from: `${one.unit}.xmp`, to: `${destination}.xmp` },
  ];
  const filings = new FilingStore(state.db);
  filings.plan([{ unit: one.unit, destination, moves, oldAssets: [] }]);
  // Cut short after both links, before the old names went.
  mkdirSync(folder(), { recursive: true });
  for (const move of moves) linkSync(move.from, move.to);
  expect(await finishPlanned(ctx, { retryProblems: false })).toEqual({ filed: [{ unit: one.unit, destination }], problems: [] });
  expect(existsSync(one.unit)).toBe(false);
  expect((await readSidecar(exiftool, `${destination}.xmp`))!.fields.hierarchicalSubject).not.toContain("Promote");

  const two = await readyPhoto("IMG_2.jpg");
  const taken = join(dir, "Pictures", "elsewhere.jpg");
  writeFileSync(taken, "another file");
  filings.plan([{ unit: two.unit, destination: taken, moves: [{ from: two.unit, to: taken }], oldAssets: [] }]);
  const blocked = await finishPlanned(ctx, { retryProblems: false });
  expect(blocked.problems).toEqual([{ unit: two.unit, problem: `${taken} is another file already` }]);
  expect(existsSync(two.unit)).toBe(true);
  // It waits for a person: not tried again every run, only once when the daemon starts.
  expect(await finishPlanned(ctx, { retryProblems: false })).toEqual({ filed: [], problems: [] });
  expect((await finishPlanned(ctx, { retryProblems: true })).problems).toHaveLength(1);
});

test("a sidecar changed just before the move: nothing moves, and the unit is looked at afresh", async () => {
  const one = await readyPhoto("IMG_1.jpg");
  writeFileSync(`${one.unit}.xmp`, `${(await Bun.file(`${one.unit}.xmp`).text())}\n`);
  const report = await fileBatch(ctx, [one]);
  expect(report.problems).toEqual([{ unit: one.unit, problem: "its sidecar changed just before it was moved" }]);
  expect(existsSync(one.unit)).toBe(true);
  expect(new FilingStore(state.db).get(one.unit)).toBeUndefined();
});
