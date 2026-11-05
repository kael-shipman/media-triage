import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES, USERS, api, configFor, describeImmich, login, mediaFolder, newUser, waitFor } from "../../test/immich/harness.ts";
import { PathMap } from "../core/path-map.ts";
import type { AccountState } from "../core/xmp.ts";
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

/** Two fresh accounts, each with a library over one folder holding a photo and the sidecar Darktable wrote. */
async function twoAccounts(prefix: string) {
  const admin = await login(USERS.alex);
  const [one, two] = [await newUser(admin.accessToken, "One"), await newUser(admin.accessToken, "Two")];
  const config = configFor(join(dir, "state"), [
    { name: "one", user: one },
    { name: "two", user: two },
  ]);
  await loginAccount(config, "one", one.password);
  await loginAccount(config, "two", two.password);
  const accounts = (await openAccounts(config)).open;
  const byName = new Map(accounts.map((account) => [account.account.name, account]));

  const folder = mediaFolder(prefix);
  const unit = join(folder.local, "photo.jpg");
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
  return { admin, one, two, config, accounts, byName, unit, store, map, ctx, copy, read, settled, token };
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
    await sync();
    expect(await entries()).toBeUndefined();

    // One favorites its copy and puts it in an album; two archives its copy.
    const [oneToken, twoToken] = [await token("one"), await token("two")];
    const [oneId, twoId] = [(await login(one)).userId, (await login(two)).userId];
    await api("PUT", "/assets", { token: oneToken, body: { ids: [copy("one").id], isFavorite: true } });
    const album = await api<{ id: string }>("POST", "/albums", { token: oneToken, body: { albumName: "Lake trip", assetIds: [copy("one").id] } });
    await api("PUT", "/assets", { token: twoToken, body: { ids: [copy("two").id], visibility: "archive" } });
    await sync();
    const byUser = (list: AccountState[] | undefined) => (list ?? []).toSorted((a, b) => (a.user === oneId ? -1 : b.user === oneId ? 1 : 0));
    expect(byUser(await entries())).toEqual([
      { user: oneId, favorite: true, visibility: "timeline", albums: [{ id: album.id, name: "Lake trip" }] },
      { user: twoId, favorite: false, visibility: "archive", albums: [] },
    ]);

    // A rename reaches the sidecar, though no asset changed.
    await api("PATCH", `/albums/${album.id}`, { token: oneToken, body: { albumName: "Lake week" } });
    await sync();
    expect(byUser(await entries())[0]?.albums).toEqual([{ id: album.id, name: "Lake week" }]);

    // Undone: nothing left to record, so the field goes.
    await api("PUT", "/assets", { token: oneToken, body: { ids: [copy("one").id], isFavorite: false } });
    await api("DELETE", `/albums/${album.id}/assets`, { token: oneToken, body: { ids: [copy("one").id] } });
    await api("PUT", "/assets", { token: twoToken, body: { ids: [copy("two").id], visibility: "timeline" } });
    await sync();
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
});
