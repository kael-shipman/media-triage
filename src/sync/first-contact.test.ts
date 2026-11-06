// The first run over an archive Immich has already indexed (DESIGN.md, section 5): nothing the sidecars hold may be
// lost. Each test is one account's copy of one photo, reconciled the way the daemon does: once, then again after the
// copy has been refreshed, as the stream's event for the refresh would make it.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES, USERS, api, configFor, describeImmich, login, mediaFolder, newUser, waitFor } from "../../test/immich/harness.ts";
import { PathMap } from "../core/path-map.ts";
import { type Asset, getAsset } from "../immich/assets.ts";
import { loginAccount } from "../immich/login.ts";
import { Exiftool } from "../sidecars/exiftool.ts";
import { readSidecar, writeSidecar } from "../sidecars/sidecar.ts";
import { State } from "../state.ts";
import { openAccounts } from "../upkeep/accounts.ts";
import { type Refreshing, reconcile } from "./reconcile.ts";
import { SyncStore } from "./store.ts";
import { learnAllAssets } from "./stream.ts";

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

/**
 * A fresh account with a library over a folder holding one photo, indexed by Immich. With `sidecarAfter`, Darktable's
 * sidecar appears only after Immich indexed the photo, so Immich doesn't know it (F1); otherwise it's there first.
 */
async function indexed(prefix: string, options: { sidecarAfter?: boolean; rating?: number } = {}) {
  const admin = await login(USERS.alex);
  const user = await newUser(admin.accessToken, "First");
  const folder = mediaFolder(prefix);
  const config = configFor(join(dir, "state"), [{ name: "one", user }]);
  await loginAccount(config, "one", user.password);
  const accounts = (await openAccounts(config)).open;
  const account = accounts[0]!;
  const unit = join(folder.local, "photo.jpg");
  copyFileSync(join(FIXTURES, "photo.jpg"), unit);
  const sidecar = async () => {
    copyFileSync(join(FIXTURES, "darktable.xmp"), `${unit}.xmp`);
    if (options.rating !== undefined) await exiftool.write(`${unit}.xmp`, { "XMP-xmp:Rating": options.rating });
  };
  if (!options.sidecarAfter) await sidecar();
  const { id: library } = await api<{ id: string }>("POST", "/libraries", {
    token: admin.accessToken,
    body: { ownerId: account.userId, name: prefix, importPaths: [folder.immich], exclusionPatterns: [] },
  });
  await api("POST", `/libraries/${library}/scan`, { token: admin.accessToken });
  const store = new SyncStore(state.db);
  const map = new PathMap(config.immich.pathMap);
  await waitFor("the copy", async () => {
    await learnAllAssets(account, store, map);
    return store.assetsAt(unit).length === 1 ? true : undefined;
  });
  const id = store.assetsAt(unit)[0]!.id;
  const read = () => getAsset(account.client, id) as Promise<Asset>;
  await waitFor("its metadata", async () => ((await read()).exifInfo?.make !== undefined || (await read()).exifInfo?.dateTimeOriginal ? true : undefined));
  // Immich's own jobs (thumbnails) update the asset after the scan: let them finish, as on a server that indexed long ago.
  await Bun.sleep(3000);
  if (options.sidecarAfter) await sidecar();
  const ctx = { config, store, exiftool, accounts: new Map(accounts.map((open) => [open.account.name, open])), dryRun: false, refreshing: new Map<string, Refreshing>() };
  /** Reconcile, and, if the copy was asked to refresh, wait for Immich to do it, then reconcile again. */
  const twice = async () => {
    const before = (await read()).updatedAt;
    const first = await reconcile(ctx, [unit]);
    if (first.refreshed > 0) {
      await waitFor("the refresh", async () => ((await read()).updatedAt !== before ? true : undefined));
      await Bun.sleep(2500);
    }
    return reconcile(ctx, [unit]);
  };
  const fields = async () => (await readSidecar(exiftool, `${unit}.xmp`))!.fields;
  return { user, account, unit, store, ctx, read, twice, fields, token: async () => (await login(user)).accessToken, id };
}

describeImmich("the first run over an archive Immich already indexed", () => {
  test("an ordinary sidecar keeps everything, and only gains the title's tag for Immich", async () => {
    const { twice, fields, read } = await indexed("first-ordinary");
    await twice();
    const after = await fields();
    expect(after).toMatchObject({ rating: 3, title: "Lake day", description: "A day by the lake" });
    expect(after.hierarchicalSubject?.toSorted()).toEqual(["People|Robin Example", "Places|Lake", "darktable|format|jpg"]);
    expect(after.tagsList?.toSorted()).toEqual(["People/Robin Example", "Places/Lake", "Title/Lake day"]);
    await waitFor("the title's tag in Immich", async () => ((await read()).tags?.some((tag) => tag.value === "Title/Lake day") ? true : undefined));
  }, 120_000);

  test("a sidecar Immich never read (made after it indexed the photo) loses nothing to the copy that didn't read it", async () => {
    const { twice, fields } = await indexed("first-unread", { sidecarAfter: true });
    await twice();
    await twice();
    const after = await fields();
    expect(after).toMatchObject({ rating: 3, title: "Lake day", description: "A day by the lake" });
    expect(after.hierarchicalSubject?.toSorted()).toEqual(["People|Robin Example", "Places|Lake", "darktable|format|jpg"]);
  }, 120_000);

  test("a reject in Darktable (-1), which Immich reads as unrated, stays a reject", async () => {
    const { twice, fields } = await indexed("first-reject", { rating: -1 });
    await twice();
    await twice();
    expect((await fields()).rating).toBe(-1);
  }, 120_000);

  test("a change made in Darktable that Immich hasn't read wins, though Immich updated the photo since", async () => {
    const { twice, fields, token, id, unit } = await indexed("first-stale");
    // Darktable changes the rating: Immich isn't told. An hour later, the photo is made a favorite in Immich, which
    // updates the asset but not its rating.
    const sidecar = (await readSidecar(exiftool, `${unit}.xmp`))!;
    await writeSidecar(exiftool, sidecar, { rating: 5 });
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(`${unit}.xmp`, hourAgo, hourAgo);
    await api("PUT", "/assets", { token: await token(), body: { ids: [id], isFavorite: true } });
    await twice();
    expect((await fields()).rating).toBe(5);
  }, 120_000);
});
