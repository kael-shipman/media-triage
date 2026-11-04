import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../state.ts";
import { type AssetRecord, SyncStore, type UnitRecord } from "./store.ts";

let dir: string;
let state: State;
let store: SyncStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  state = State.open(dir);
  store = new SyncStore(state.db);
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

const asset = (id: string, account: string, local: string | null): AssetRecord => ({
  id,
  account,
  owner: `${account}-id`,
  library: "lib",
  path: `/mnt/media/${id}.jpg`,
  local,
  trashed: false,
  visibility: "timeline",
});

test("assets: kept, found by local path across accounts, updated, forgotten", () => {
  store.putAssets([asset("a1", "alex", "/media/a.jpg"), asset("s1", "sam", "/media/a.jpg"), asset("s2", "sam", null)]);
  expect(store.assetsAt("/media/a.jpg").map((record) => record.id)).toEqual(["a1", "s1"]);
  expect(store.unknownAssets(["a1", "x", "s2"])).toEqual(["x"]);

  store.updateAssets([{ id: "a1", trashed: true }, { id: "s1", visibility: "archive" }]);
  expect(store.asset("a1")).toMatchObject({ trashed: true, visibility: "timeline", path: "/mnt/media/a1.jpg" });
  expect(store.asset("s1")).toMatchObject({ trashed: false, visibility: "archive" });

  store.forgetAccount("sam");
  expect(store.countAssets()).toBe(1);
  store.removeAssets(["a1"]);
  expect(store.asset("a1")).toBeUndefined();
});

test("units: last-synced values and the sidecar's stamp, kept between openings", () => {
  const unit: UnitRecord = {
    path: "/media/a.jpg",
    sidecar: { size: 1234, mtimeMs: 1730000000123.456, ino: 42 },
    synced: { rating: 3, title: "Lake day", description: null, creator: "Alex Example", tags: ["Places/Lake"], date: "2021:06:15 10:20:30+02:00", gps: null, trashed: false },
    updated: "2026-11-04T12:00:00.000Z",
  };
  store.putUnits([unit, { ...unit, path: "/media/b.jpg", sidecar: undefined }]);
  state.close();
  state = State.open(dir);
  store = new SyncStore(state.db);
  expect(store.unit("/media/a.jpg")).toEqual(unit);
  expect(store.unit("/media/b.jpg")?.sidecar).toBeUndefined();
  store.removeUnit("/media/a.jpg");
  expect(store.unit("/media/a.jpg")).toBeUndefined();
});
