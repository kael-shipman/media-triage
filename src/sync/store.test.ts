import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../state.ts";
import { type AssetRecord, type FaceRecord, SyncStore, type UnitRecord } from "./store.ts";

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
  favorite: false,
});

test("assets: kept, found by local path across accounts, updated, forgotten", () => {
  store.putAssets([asset("a1", "alex", "/media/a.jpg"), asset("s1", "sam", "/media/a.jpg"), asset("s2", "sam", null)]);
  expect(store.assetsAt("/media/a.jpg").map((record) => record.id)).toEqual(["a1", "s1"]);
  expect(store.unknownAssets(["a1", "x", "s2"])).toEqual(["x"]);

  store.updateAssets([{ id: "a1", trashed: true }, { id: "s1", visibility: "archive", favorite: true }]);
  expect(store.asset("a1")).toMatchObject({ trashed: true, visibility: "timeline", favorite: false, path: "/mnt/media/a1.jpg" });
  expect(store.asset("s1")).toMatchObject({ trashed: false, visibility: "archive", favorite: true });

  store.forgetAccount("sam");
  expect(store.countAssets()).toBe(1);
  store.removeAssets(["a1"]);
  expect(store.asset("a1")).toBeUndefined();
});

test("albums: names and assets per account, renames, lost albums, and an asset's albums across accounts", () => {
  expect(store.putAlbums("alex", [{ id: "album1", name: "Lake" }, { id: "album2", name: "Beach" }])).toEqual([]);
  store.putAlbums("sam", [{ id: "album1", name: "Lake" }]);
  store.addToAlbums("alex", [{ album: "album1", asset: "a1" }, { album: "album2", asset: "a1" }, { album: "album2", asset: "a2" }]);
  store.addToAlbums("sam", [{ album: "album1", asset: "s1" }]);
  expect(store.albumsOf("a1")).toEqual([{ id: "album1", name: "Lake" }, { id: "album2", name: "Beach" }]);
  expect(store.albumAssets("album1")).toEqual(["a1", "s1"]);

  // A rename is reported, with the album's assets; a new album isn't.
  expect(store.putAlbums("alex", [{ id: "album2", name: "Sea" }, { id: "album3", name: "New" }])).toEqual(["album2"]);
  expect(store.albumsOf("a2")).toEqual([{ id: "album2", name: "Sea" }]);

  // Taken out of one album; alex loses another, which sam still sees.
  store.removeFromAlbums("alex", [{ album: "album2", asset: "a2" }]);
  expect(store.albumsOf("a2")).toEqual([]);
  expect(store.removeAlbums("alex", ["album1"])).toEqual(["a1"]);
  expect(store.albumsOf("a1")).toEqual([{ id: "album2", name: "Sea" }]);
  expect(store.albumsOf("s1")).toEqual([{ id: "album1", name: "Lake" }]);

  // A removed asset leaves its albums.
  store.removeAssets(["a1"]);
  expect(store.albumAssets("album2")).toEqual([]);
});

test("a reset keeps albums, stale, until the stream has sent them again; what it didn't send is swept", () => {
  store.putAssets([asset("a1", "alex", "/media/a.jpg")]);
  store.putAlbums("alex", [{ id: "kept", name: "Kept" }, { id: "gone", name: "Gone" }]);
  store.addToAlbums("alex", [{ album: "kept", asset: "a1" }, { album: "kept", asset: "a2" }, { album: "gone", asset: "a3" }]);
  store.putAlbums("sam", [{ id: "kept", name: "Kept" }]);
  store.addToAlbums("sam", [{ album: "kept", asset: "s1" }]);
  expect(store.sweep("alex")).toBeUndefined();

  store.forgetAccount("alex");
  expect(store.countAssets("alex")).toBe(0);
  expect(store.albumsOf("a2")).toEqual([{ id: "kept", name: "Kept" }]);
  store.putAlbums("alex", [{ id: "kept", name: "Kept" }]);
  store.addToAlbums("alex", [{ album: "kept", asset: "a1" }]);
  expect(store.sweep("alex")?.sort()).toEqual(["a2", "a3"]);
  expect(store.albumAssets("kept")).toEqual(["a1", "s1"]);
  expect(store.albumsOf("a3")).toEqual([]);
  expect(store.sweep("alex")).toBeUndefined();
});

const face = (id: string, asset: string, person: string | null): FaceRecord => ({
  id,
  asset,
  person,
  boundingBoxX1: 10,
  boundingBoxY1: 20,
  boundingBoxX2: 110,
  boundingBoxY2: 140,
  imageWidth: 1000,
  imageHeight: 800,
  source: "machine-learning",
  visible: true,
  deleted: null,
});

test("faces and people: faces by asset and by person, people's changes reported, and a reset's sweep", () => {
  store.putFaces([face("f1", "a1", "p1"), face("f2", "a1", null), face("f3", "a2", "p1")]);
  store.putFaces([{ ...face("f2", "a1", "p2"), deleted: "2026-11-04T12:00:00.000Z" }]);
  expect(store.facesOn("a1")).toEqual([face("f1", "a1", "p1"), { ...face("f2", "a1", "p2"), deleted: "2026-11-04T12:00:00.000Z" }]);
  expect(store.assetsWithPerson("p1")).toEqual(["a1", "a2"]);
  expect(store.removeFaces(["f3", "missing"])).toEqual(["a2"]);
  expect(store.assetsWithPerson("p1")).toEqual(["a1"]);

  // New people, renames and hiding are reported; the same record again isn't.
  expect(store.putPeople([{ account: "alex", id: "p1", name: "", hidden: false }])).toEqual(["p1"]);
  expect(store.putPeople([{ account: "alex", id: "p1", name: "", hidden: false }])).toEqual([]);
  expect(store.putPeople([{ account: "alex", id: "p1", name: "Robin", hidden: false }, { account: "sam", id: "p1", name: "Robin", hidden: true }])).toEqual(["p1", "p1"]);
  expect(store.person("sam", "p1")).toEqual({ account: "sam", id: "p1", name: "Robin", hidden: true });
  store.removePerson("sam", "p1");
  expect(store.person("sam", "p1")).toBeUndefined();

  // A reset marks every face stale, and the account's people; the sweep drops what wasn't sent again.
  store.putPeople([{ account: "alex", id: "p2", name: "Sam", hidden: false }]);
  store.forgetAccount("alex");
  store.putFaces([face("f1", "a1", "p1")]);
  store.putPeople([{ account: "alex", id: "p1", name: "Robin", hidden: false }]);
  expect(store.sweep("alex")?.sort()).toEqual(["a1"]);
  expect(store.facesOn("a1").map((record) => record.id)).toEqual(["f1"]);
  expect(store.person("alex", "p2")).toBeUndefined();
  expect(store.person("alex", "p1")?.name).toBe("Robin");
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
