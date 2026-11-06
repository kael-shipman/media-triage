import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FIXTURES, USERS, api, configFor, describeImmich, login, mediaFolder, newUser, waitFor } from "../../test/immich/harness.ts";
import { PathMap } from "../core/path-map.ts";
import { type AccountState, type XmpFields, darktableReads } from "../core/xmp.ts";
import { fileBatch } from "../filing/file.ts";
import { restorePending } from "../filing/restore.ts";
import { FilingStore } from "../filing/store.ts";
import { type Asset, getAsset } from "../immich/assets.ts";
import { loginAccount } from "../immich/login.ts";
import { Exiftool } from "../sidecars/exiftool.ts";
import { readSidecar, writeSidecar } from "../sidecars/sidecar.ts";
import { State } from "../state.ts";
import { openAccounts } from "../upkeep/accounts.ts";
import { type Refreshing, accountStates, reconcile } from "./reconcile.ts";
import { SyncStore } from "./store.ts";
import { consumeStream, learnAllAssets } from "./stream.ts";

let exiftool: Exiftool;
let dir: string;
let state: State;
beforeAll(async () => {
  exiftool = await Exiftool.start();
});
afterAll(() => exiftool.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  state = State.open(join(dir, "state"));
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

test("each account's state from its copies: read, locked, or kept from the sidecar when there's nothing to go by", () => {
  const store = new SyncStore(state.db);
  const record = (id: string, account: string, visibility = "timeline", favorite = false) => ({
    id,
    account,
    owner: `${account}-user`,
    library: "lib",
    path: `/mnt/media/${id}.jpg`,
    local: "/media/photo.jpg",
    trashed: false,
    visibility,
    favorite,
  });
  store.putAlbums("one", [{ id: "album", name: "Lake" }]);
  store.addToAlbums("one", [{ album: "album", asset: "a1" }]);
  const read = new Map([["a1", { id: "a1", isFavorite: true, visibility: "hidden" } as Asset]]);
  const kept = { user: "three-user", favorite: true, visibility: "timeline", albums: [] };
  const stale = { user: "two-user", favorite: false, visibility: "archive", albums: [] };
  // One's copy was read (a Live Photo's video is "hidden": Immich's, not a choice); two's is locked, so Immich won't
  // show it, and the stream's record says; three has no copy here, and keeps its entry.
  expect(accountStates(store, [record("a1", "one"), record("t1", "two", "locked", true)], read, [kept, stale])).toEqual([
    kept,
    { user: "one-user", favorite: true, visibility: "timeline", albums: [{ id: "album", name: "Lake" }] },
    { user: "two-user", favorite: true, visibility: "locked", albums: [] },
  ]);
  // A copy that's gone, and not locked, is nothing to go by.
  expect(accountStates(store, [record("t1", "two")], new Map(), [stale])).toEqual([stale]);
});

test("a unit whose media file is gone is only noted as gone, for its orphan sidecar (F11)", async () => {
  const store = new SyncStore(state.db);
  const config = configFor(join(dir, "state"), []);
  const ctx = { config, store, exiftool, accounts: new Map(), dryRun: false, refreshing: new Map<string, Refreshing>() };
  const unit = join(dir, "gone.jpg");
  copyFileSync(join(FIXTURES, "darktable.xmp"), `${unit}.xmp`);
  const synced = { rating: 3, title: null, description: null, creator: null, tags: [], date: null, gps: null, trashed: false };
  store.putUnits([{ path: unit, synced, updated: "2026-11-04T00:00:00.000Z" }]);
  await reconcile({ ...ctx, dryRun: true }, [unit]);
  expect(store.unit(unit)?.gone).toBeUndefined();
  const report = await reconcile(ctx, [unit]);
  expect(report).toMatchObject({ written: [], refreshed: 0, waiting: [] });
  expect(store.unit(unit)?.gone).toBeDefined();
  expect(store.unit(unit)?.synced).toEqual(synced);
});

/**
 * Two fresh accounts, each with a library over one folder holding a photo and the sidecar Darktable wrote. With
 * `inbox`, the folder is an inbox and the photo is in its source "Phone", whose creator is Alex Example, and the
 * settle time is a second.
 */
async function twoAccounts(prefix: string, options: { inbox?: boolean; admin?: boolean } = {}) {
  const admin = await login(USERS.alex);
  const [one, two] = [await newUser(admin.accessToken, "One"), await newUser(admin.accessToken, "Two")];
  const folder = mediaFolder(prefix);
  const config = configFor(
    join(dir, "state"),
    [
      { name: "one", user: one },
      { name: "two", user: two },
      ...(options.admin ? [{ name: "alex", user: USERS.alex }] : []),
    ],
    options.inbox
      ? { paths: { inbox: folder.local, archive: folder.local }, sources: [{ folder: "Phone", creator: "Alex Example" }], timing: { settle: "1s" } }
      : {},
  );
  await loginAccount(config, "one", one.password);
  await loginAccount(config, "two", two.password);
  if (options.admin) await loginAccount(config, "alex", USERS.alex.password);
  const all = (await openAccounts(config)).open;
  const byName = new Map(all.map((account) => [account.account.name, account]));
  // The admin, if it's configured, owns no copies: it's there for scanning.
  const accounts = all.filter((account) => account.account.name !== "alex");

  const unit = join(folder.local, ...(options.inbox ? ["Phone"] : []), "photo.jpg");
  mkdirSync(dirname(unit), { recursive: true });
  copyFileSync(join(FIXTURES, "photo.jpg"), unit);
  copyFileSync(join(FIXTURES, "darktable.xmp"), `${unit}.xmp`);
  for (const account of accounts) {
    const { id } = await api<{ id: string }>("POST", "/libraries", {
      token: admin.accessToken,
      body: { ownerId: account.userId, name: prefix, importPaths: [folder.immich], exclusionPatterns: [] },
    });
    await api("POST", `/libraries/${id}/scan`, { token: admin.accessToken });
  }
  const store = new SyncStore(state.db);
  const map = new PathMap(config.immich.pathMap);
  await waitFor("both copies", async () => {
    for (const account of accounts) await learnAllAssets(account, store, map);
    return store.assetsAt(unit).length === 2 ? true : undefined;
  });
  const ctx = { config, store, exiftool, accounts: byName, dryRun: false, refreshing: new Map<string, Refreshing>() };
  const copy = (name: string) => store.assetsAt(unit).find((record) => record.account === name)!;
  const read = (name: string) => getAsset(byName.get(name)!.client, copy(name).id) as Promise<Asset>;
  const settled = (what: string, check: (one: Asset, two: Asset) => boolean) =>
    waitFor(what, async () => {
      const [a, b] = [await read("one"), await read("two")];
      return check(a, b) ? true : undefined;
    });
  await settled("the scans' metadata", (a, b) => a.exifInfo?.rating === 3 && b.exifInfo?.rating === 3);
  const token = async (name: "one" | "two") => (await login(name === "one" ? one : two)).accessToken;
  return { admin, one, two, folder, config, accounts, byName, unit, store, map, ctx, copy, read, settled, token };
}

describeImmich("reconciling a unit with two accounts' copies", () => {
  test("first run, a Darktable edit, an Immich edit, a trash, and a quiet pass", async () => {
    const { one, unit, store, ctx, copy, settled } = await twoAccounts("reconcile");
    const tagsOf = (asset: Asset) => (asset.tags ?? []).map((tag) => tag.value).sort();

    // A dry run writes and records nothing.
    const dry = await reconcile({ ...ctx, dryRun: true }, [unit]);
    expect(dry.written.map((write) => write.unit)).toEqual([unit]);
    expect(store.unit(unit)).toBeUndefined();

    // First run: the title becomes Immich's tag, and both copies read it.
    const first = await reconcile(ctx, [unit]);
    expect(first.conflicts).toEqual([]);
    expect(first.written[0]?.fields).toContain("XMP-digiKam:TagsList");
    expect(first.refreshed).toBe(2);
    await settled("the title tag on both copies", (a, b) => tagsOf(a).includes("Title/Lake day") && tagsOf(b).includes("Title/Lake day"));
    expect(store.unit(unit)?.synced).toMatchObject({ rating: 3, title: "Lake day", tags: ["People/Robin Example", "Places/Lake"] });

    // Darktable changes the rating: both copies get it.
    const before = (await readSidecar(exiftool, `${unit}.xmp`))!;
    await writeSidecar(exiftool, before, { rating: 5 });
    const second = await reconcile(ctx, [unit]);
    expect(second.refreshed).toBe(2);
    await settled("the rating from Darktable", (a, b) => a.exifInfo?.rating === 5 && b.exifInfo?.rating === 5);

    // Account one adds a tag in Immich (which writes the sidecar): Darktable's fields and account two get it.
    const [tag] = await api<{ id: string }[]>("PUT", "/tags", { token: (await login(one)).accessToken, body: { tags: ["Places/Beach"] } });
    await api("PUT", `/tags/${tag!.id}/assets`, { token: (await login(one)).accessToken, body: { ids: [copy("one").id] } });
    await waitFor("Immich's sidecar write", async () => ((await readSidecar(exiftool, `${unit}.xmp`))?.fields.tagsList?.includes("Places/Beach") ? true : undefined));
    await reconcile(ctx, [unit]);
    expect((await readSidecar(exiftool, `${unit}.xmp`))!.fields.hierarchicalSubject).toContain("Places|Beach");
    await settled("the tag on account two", (_a, b) => tagsOf(b).includes("Places/Beach"));

    // Nothing changed: nothing written, nothing refreshed.
    const quiet = await reconcile(ctx, [unit]);
    expect(quiet).toMatchObject({ written: [], refreshed: 0, trashed: [], restored: [] });

    // Account one trashes its copy: account two's follows (F8); restoring follows too.
    await api("DELETE", "/assets", { token: (await login(one)).accessToken, body: { ids: [copy("one").id], force: false } });
    expect((await reconcile(ctx, [unit])).trashed).toEqual([copy("two").id]);
    await settled("account two's copy trashed", (_a, b) => b.isTrashed);
    await api("POST", "/trash/restore/assets", { token: (await login(one)).accessToken, body: { ids: [copy("one").id] } });
    expect((await reconcile(ctx, [unit])).restored).toEqual([copy("two").id]);
    await settled("account two's copy restored", (_a, b) => !b.isTrashed);
  }, 180_000);

  test("each account's favorite, visibility and albums reach the sidecar, from the stream (F9)", async () => {
    const { one, two, accounts, unit, store, map, ctx, copy, token } = await twoAccounts("account-state");
    const sync = async () => {
      for (const account of accounts) await consumeStream(account, store, map, { act: async (units) => void (await reconcile(ctx, units)) });
    };
    const entries = async () => (await readSidecar(exiftool, `${unit}.xmp`))!.fields.accounts;
    // A change can reach the stream a moment after the API call returns: read until the sidecar shows it.
    const syncUntil = (what: string, check: () => Promise<boolean>) =>
      waitFor(what, async () => {
        await sync();
        return (await check()) ? true : undefined;
      });
    await sync();
    expect(await entries()).toBeUndefined();

    // One favorites its copy and puts it in an album; two archives its copy.
    const [oneToken, twoToken] = [await token("one"), await token("two")];
    const [oneId, twoId] = [(await login(one)).userId, (await login(two)).userId];
    await api("PUT", "/assets", { token: oneToken, body: { ids: [copy("one").id], isFavorite: true } });
    const album = await api<{ id: string }>("POST", "/albums", { token: oneToken, body: { albumName: "Lake trip", assetIds: [copy("one").id] } });
    await api("PUT", "/assets", { token: twoToken, body: { ids: [copy("two").id], visibility: "archive" } });
    await syncUntil("both accounts' state", async () => (await entries())?.length === 2 && (await entries())!.some((entry) => entry.albums.length > 0));
    const byUser = (list: AccountState[] | undefined) => (list ?? []).toSorted((a, b) => (a.user === oneId ? -1 : b.user === oneId ? 1 : 0));
    expect(byUser(await entries())).toEqual([
      { user: oneId, favorite: true, visibility: "timeline", albums: [{ id: album.id, name: "Lake trip" }] },
      { user: twoId, favorite: false, visibility: "archive", albums: [] },
    ]);

    // A rename reaches the sidecar, though no asset changed.
    await api("PATCH", `/albums/${album.id}`, { token: oneToken, body: { albumName: "Lake week" } });
    await syncUntil("the rename", async () => byUser(await entries())[0]?.albums[0]?.name === "Lake week");
    expect(byUser(await entries())[0]?.albums).toEqual([{ id: album.id, name: "Lake week" }]);

    // Undone: nothing left to record, so the field goes.
    await api("PUT", "/assets", { token: oneToken, body: { ids: [copy("one").id], isFavorite: false } });
    await api("DELETE", `/albums/${album.id}/assets`, { token: oneToken, body: { ids: [copy("one").id] } });
    await api("PUT", "/assets", { token: twoToken, body: { ids: [copy("two").id], visibility: "timeline" } });
    await syncUntil("nothing left to record", async () => (await entries()) === undefined);
    expect(await entries()).toBeUndefined();
    expect(store.albumsOf(copy("one").id)).toEqual([]);
  }, 180_000);

  test("a tag removed in Darktable stays removed when the unit is reconciled again before Immich re-reads the sidecar", async () => {
    const { unit, ctx, settled } = await twoAccounts("race");
    const tagsOf = (asset: Asset) => (asset.tags ?? []).map((tag) => tag.value).sort();
    await reconcile(ctx, [unit]);
    await settled("the first run's tags", (a, b) => tagsOf(a).includes("Title/Lake day") && tagsOf(b).includes("Title/Lake day"));

    const sidecar = (await readSidecar(exiftool, `${unit}.xmp`))!;
    await writeSidecar(exiftool, sidecar, { tags: ["People/Robin Example"] });
    await reconcile(ctx, [unit]);
    // The watcher would see the daemon's own write and reconcile the unit again, a moment later.
    await reconcile(ctx, [unit]);
    expect((await readSidecar(exiftool, `${unit}.xmp`))!.fields.hierarchicalSubject).not.toContain("Places|Lake");
    await settled("the tag gone from both copies", (a, b) => !tagsOf(a).includes("Places/Lake") && !tagsOf(b).includes("Places/Lake"));
    await reconcile(ctx, [unit]);
    expect((await readSidecar(exiftool, `${unit}.xmp`))!.fields.hierarchicalSubject).not.toContain("Places|Lake");
  }, 180_000);

  test("a named face becomes a tag and a region; a rename and a deleted face follow; a hand-made tag stays (F10)", async () => {
    const { accounts, unit, store, map, ctx, copy, read, token } = await twoAccounts("faces");
    const sync = async () => {
      for (const account of accounts) await consumeStream(account, store, map, { act: async (units) => void (await reconcile(ctx, units)) });
    };
    const sidecar = async () => (await readSidecar(exiftool, `${unit}.xmp`))!.fields;
    // A change can reach the stream a moment after the API call returns: read until the sidecar shows it.
    const syncUntil = (what: string, check: (fields: XmpFields) => boolean) =>
      waitFor(what, async () => {
        await sync();
        return check(await sidecar()) ? true : undefined;
      });
    await sync();

    // A face added by hand in account one, for a new person. The fixture's sidecar already has a hand-made tag,
    // People|Robin Example.
    const oneToken = await token("one");
    const person = await api<{ id: string }>("POST", "/people", { token: oneToken, body: { name: "Kit Example" } });
    const asset = await read("one");
    const [width, height] = [asset.width ?? 0, asset.height ?? 0];
    await api("POST", "/faces", {
      token: oneToken,
      body: { assetId: copy("one").id, personId: person.id, imageWidth: width, imageHeight: height, x: width / 4, y: height / 4, width: width / 4, height: height / 4 },
    });
    await syncUntil("the face's tag", (fields) => fields.hierarchicalSubject?.includes("People|Kit Example") === true);
    let fields = await sidecar();
    expect(fields.hierarchicalSubject).toEqual(expect.arrayContaining(["People|Kit Example", "People|Robin Example"]));
    const region = fields.regions?.regions.find((each) => each.name === "Kit Example");
    expect(region?.type).toBe("Face");
    expect(region?.area?.x).toBeCloseTo(0.375, 2);
    expect(region?.area?.w).toBeCloseTo(0.25, 2);

    // A rename: the tag and region follow.
    await api("PUT", `/people/${person.id}`, { token: oneToken, body: { name: "Kit Renamed" } });
    await syncUntil("the rename", (fields) => fields.hierarchicalSubject?.includes("People|Kit Renamed") === true);
    fields = await sidecar();
    expect(fields.hierarchicalSubject).toContain("People|Kit Renamed");
    expect(fields.hierarchicalSubject).not.toContain("People|Kit Example");
    expect(fields.regions?.regions.map((each) => each.name)).toEqual(["Kit Renamed"]);

    // The face is deleted: the daemon's tag and region go; the hand-made tag stays.
    const faces = await api<{ id: string }[]>("GET", `/faces?id=${copy("one").id}`, { token: oneToken });
    for (const face of faces) await api("DELETE", `/faces/${face.id}`, { token: oneToken, body: { force: false } });
    await syncUntil("the face's tag gone", (fields) => fields.hierarchicalSubject?.includes("People|Kit Renamed") === false);
    fields = await sidecar();
    expect(fields.hierarchicalSubject).not.toContain("People|Kit Renamed");
    expect(fields.hierarchicalSubject).toContain("People|Robin Example");
    expect(fields.regions).toBeUndefined();
  }, 180_000);

  test("an inbox unit tagged Promote is ready once every copy has read the sidecar; without a title it needs one", async () => {
    const { unit, ctx, settled } = await twoAccounts("ready", { inbox: true });
    const tagsOf = (asset: Asset) => (asset.tags ?? []).map((tag) => tag.value).sort();
    await reconcile(ctx, [unit]);

    // Tagged Promote in Darktable: not ready until both copies have read it.
    const sidecar = (await readSidecar(exiftool, `${unit}.xmp`))!;
    await writeSidecar(exiftool, sidecar, { tags: ["People/Robin Example", "Places/Lake", "Promote"] });
    const tagged = await reconcile(ctx, [unit]);
    expect(tagged.ready).toEqual([]);
    expect(tagged.notReady).toEqual([{ unit, why: "a copy hasn't read the sidecar yet" }]);
    await settled("Promote on both copies", (a, b) => tagsOf(a).includes("Promote") && tagsOf(b).includes("Promote"));
    await Bun.sleep(1100);
    const ready = await reconcile(ctx, [unit]);
    expect(ready.ready.map((each) => [each.unit, each.title, each.copies.length])).toEqual([[unit, "Lake day", 2]]);

    // The title goes: the unit needs one, and says so.
    await writeSidecar(exiftool, (await readSidecar(exiftool, `${unit}.xmp`))!, { title: null });
    const untitled = await reconcile(ctx, [unit]);
    expect(untitled.notReady).toEqual([{ unit, why: "it has no title" }]);
    expect((await readSidecar(exiftool, `${unit}.xmp`))!.fields.hierarchicalSubject).toContain("Promote|Needs a title");
  }, 180_000);

  test("filing moves a ready unit into Pictures, Immich finds it there, and its state is held, then put back", async () => {
    const { unit, folder, accounts, store, map, ctx, copy, settled, token } = await twoAccounts("filing", { inbox: true, admin: true });
    const tagsOf = (asset: Asset) => (asset.tags ?? []).map((tag) => tag.value).sort();
    const sync = async () => {
      for (const account of accounts) await consumeStream(account, store, map, { act: async (units) => void (await reconcile(ctx, units)) });
    };
    await sync();

    // One favorites its copy, puts it in an album and adds a face by hand; two archives its copy. The sidecar records
    // their state (F9), and the state has the face.
    const old = { one: copy("one").id, two: copy("two").id };
    const [oneToken, twoToken] = [await token("one"), await token("two")];
    await api("PUT", "/assets", { token: oneToken, body: { ids: [old.one], isFavorite: true } });
    const album = await api<{ id: string }>("POST", "/albums", { token: oneToken, body: { albumName: "Lake trip", assetIds: [old.one] } });
    await api("PUT", "/assets", { token: twoToken, body: { ids: [old.two], visibility: "archive" } });
    const person = await api<{ id: string }>("POST", "/people", { token: oneToken, body: { name: "Kit Example" } });
    const shown = (await getAsset(ctx.accounts.get("one")!.client, old.one))!;
    const [width, height] = [shown.width ?? 0, shown.height ?? 0];
    await api("POST", "/faces", {
      token: oneToken,
      body: { assetId: old.one, personId: person.id, imageWidth: width, imageHeight: height, x: width / 4, y: height / 4, width: width / 4, height: height / 4 },
    });
    await waitFor("the state in the sidecar, and the face in the state", async () => {
      await sync();
      const entries = (await readSidecar(exiftool, `${unit}.xmp`))!.fields.accounts ?? [];
      return entries.length === 2 && entries.some((entry) => entry.albums.length === 1) && store.facesOn(old.one).length === 1 ? true : undefined;
    });
    const before = (await readSidecar(exiftool, `${unit}.xmp`))!.fields.accounts;

    // Tagged Promote in Darktable; ready once both copies have read it.
    const sidecar = (await readSidecar(exiftool, `${unit}.xmp`))!;
    await writeSidecar(exiftool, sidecar, { tags: [...darktableReads(sidecar.fields).tags, "Promote"] });
    await reconcile(ctx, [unit]);
    await settled("Promote on both copies", (a, b) => tagsOf(a).includes("Promote") && tagsOf(b).includes("Promote"));
    await Bun.sleep(1100);
    const { ready } = await reconcile(ctx, [unit]);
    expect(ready).toHaveLength(1);

    const report = await fileBatch(ctx, ready);
    const destination = join(folder.local, "Pictures", "2021.06.15 - Lake day", "2021.06.15-10.20.30 - Alex Example.jpg");
    expect(report).toEqual({ filed: [{ unit, destination }], problems: [] });
    expect(existsSync(unit)).toBe(false);

    // Immich scans: the new copies appear, without Promote, and the old ones go offline.
    const fresh = await waitFor("both new copies", async () => {
      for (const account of accounts) await learnAllAssets(account, store, map);
      const found = store.assetsAt(destination);
      return found.length === 2 ? found : undefined;
    });
    await waitFor("the old copies offline", async () => {
      const olds = await Promise.all([getAsset(ctx.accounts.get("one")!.client, old.one), getAsset(ctx.accounts.get("two")!.client, old.two)]);
      return olds.every((asset) => !asset || asset.isOffline) ? true : undefined;
    });
    const newOne = (await getAsset(ctx.accounts.get("one")!.client, fresh.find((record) => record.account === "one")!.id))!;
    expect(newOne.isFavorite).toBe(false);
    await waitFor("the new copy's metadata", async () => {
      const asset = await getAsset(ctx.accounts.get("one")!.client, newOne.id);
      return asset?.exifInfo?.rating === 3 ? true : undefined;
    });
    expect(tagsOf((await getAsset(ctx.accounts.get("one")!.client, newOne.id))!)).not.toContain("Promote");

    // Held: the new copies aren't favorites yet, but the sidecar keeps what filing will put back.
    await sync();
    await reconcile(ctx, [destination]);
    expect((await readSidecar(exiftool, `${destination}.xmp`))!.fields.accounts).toEqual(before);

    // Put back: each account's state on its new copy, and the face added by hand. Then the hold is released.
    const restored = await waitFor("the unit put back", async () => {
      const report = await restorePending(ctx);
      return report.done.length > 0 ? report.done : undefined;
    }, 60_000);
    expect(restored).toEqual([{ unit, problems: [] }]);
    const [one, two] = ["one", "two"].map((name) => fresh.find((record) => record.account === name)!.id);
    const putBack = (await getAsset(ctx.accounts.get("one")!.client, one!))!;
    expect(putBack.isFavorite).toBe(true);
    expect(String((await getAsset(ctx.accounts.get("two")!.client, two!))!.visibility)).toBe("archive");
    expect((await api<{ id: string }[]>("GET", `/albums?assetId=${one}`, { token: oneToken })).map((each) => each.id)).toEqual([album.id]);
    expect((await api<{ person: { id: string } | null }[]>("GET", `/faces?id=${one}`, { token: oneToken })).map((face) => face.person?.id)).toEqual([person.id]);
    expect(store.isBeingPutBack(destination)).toBe(false);
    expect(new FilingStore(state.db).get(unit)?.status).toBe("done");
  }, 180_000);

  test("a copy learned after its unit was trashed is trashed too, rather than restoring it (F8)", async () => {
    const { unit, accounts, store, map, ctx, copy, read, token } = await twoAccounts("late-trash");
    // The first syncs see only account one's copy, which one then trashes.
    const late = copy("two").id;
    store.removeAssets([late]);
    await reconcile(ctx, [unit]);
    await api("DELETE", "/assets", { token: await token("one"), body: { ids: [copy("one").id], force: false } });
    await waitFor("one's copy in the trash", async () => ((await read("one")).isTrashed ? true : undefined));
    await reconcile(ctx, [unit]);
    expect(store.unit(unit)?.synced.trashed).toBe(true);

    // Account two's copy, not in the trash, is learned (a new account's library): it follows the unit.
    await learnAllAssets(accounts.find((account) => account.account.name === "two")!, store, map);
    const report = await reconcile(ctx, [unit]);
    expect(report).toMatchObject({ trashed: [late], restored: [] });
    await waitFor("two's copy in the trash", async () => ((await read("two")).isTrashed ? true : undefined));
    expect((await read("one")).isTrashed).toBe(true);
  }, 180_000);

  test("a copy learned after the first sync doesn't undo what that sync wrote, such as the title tag", async () => {
    const { unit, accounts, store, map, ctx, copy, settled } = await twoAccounts("late-copy");
    const tagsOf = (asset: Asset) => (asset.tags ?? []).map((tag) => tag.value).sort();
    // The first sync sees only account one's copy; account two's read the sidecar before the title tag was written.
    const late = copy("two").id;
    store.removeAssets([late]);
    await reconcile(ctx, [unit]);
    expect(store.unit(unit)?.synced.title).toBe("Lake day");

    await learnAllAssets(accounts.find((account) => account.account.name === "two")!, store, map);
    expect(store.assetsAt(unit).map((record) => record.id)).toContain(late);
    const second = await reconcile(ctx, [unit]);
    expect(second.conflicts).toEqual([]);
    expect(store.unit(unit)?.synced.title).toBe("Lake day");
    expect((await readSidecar(exiftool, `${unit}.xmp`))!.fields.title).toBe("Lake day");
    await settled("the title tag on both copies", (a, b) => tagsOf(a).includes("Title/Lake day") && tagsOf(b).includes("Title/Lake day"));
  }, 180_000);
});
