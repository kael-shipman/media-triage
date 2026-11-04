import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
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
import { reconcile } from "./reconcile.ts";
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

describeImmich("reconciling a unit with two accounts' copies", () => {
  test("first run, a Darktable edit, an Immich edit, a trash, and a quiet pass", async () => {
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

    // One folder, with a photo and the sidecar Darktable wrote, indexed by a library of each account.
    const folder = mediaFolder("reconcile");
    const unit = join(folder.local, "photo.jpg");
    copyFileSync(join(FIXTURES, "photo.jpg"), unit);
    copyFileSync(join(FIXTURES, "darktable.xmp"), `${unit}.xmp`);
    for (const account of accounts) {
      const { id } = await api<{ id: string }>("POST", "/libraries", {
        token: admin.accessToken,
        body: { ownerId: account.userId, name: "reconcile", importPaths: [folder.immich], exclusionPatterns: [] },
      });
      await api("POST", `/libraries/${id}/scan`, { token: admin.accessToken });
    }
    const store = new SyncStore(state.db);
    const map = new PathMap(config.immich.pathMap);
    await waitFor("both copies", async () => {
      for (const account of accounts) await learnAllAssets(account, store, map);
      return store.assetsAt(unit).length === 2 ? true : undefined;
    });
    const ctx = { config, store, exiftool, accounts: byName, dryRun: false };
    const copy = (name: string) => store.assetsAt(unit).find((record) => record.account === name)!;
    const read = (name: string) => getAsset(byName.get(name)!.client, copy(name).id) as Promise<Asset>;
    const tagsOf = (asset: Asset) => (asset.tags ?? []).map((tag) => tag.value).sort();
    const settled = (what: string, check: (one: Asset, two: Asset) => boolean) =>
      waitFor(what, async () => {
        const [a, b] = [await read("one"), await read("two")];
        return check(a, b) ? true : undefined;
      });
    await settled("the scans' metadata", (a, b) => a.exifInfo?.rating === 3 && b.exifInfo?.rating === 3);

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
});
