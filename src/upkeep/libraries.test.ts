import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USERS, configFor, describeImmich, login, mediaFolder, newUser, photos } from "../../test/immich/harness.ts";
import type { Config } from "../config.ts";
import { exclusionsFor } from "../core/libraries.ts";
import { libraryPages } from "../immich/assets.ts";
import { createLibrary, listLibraries, waitForLibraryQueue } from "../immich/libraries.ts";
import { loginAccount } from "../immich/login.ts";
import { type OpenAccount, openAccounts } from "./accounts.ts";
import { joinClusterGroup } from "./cluster.ts";
import { upkeepLibraries } from "./libraries.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The paths of a library's online assets, relative to `root` (Immich's path). */
async function indexed(owner: OpenAccount, libraryId: string, root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const page of libraryPages(owner.client, libraryId)) {
    paths.push(...page.filter((asset) => !asset.isOffline).map((asset) => asset.originalPath.slice(root.length + 1)));
  }
  return paths.sort();
}

describeImmich("library upkeep, against Immich", () => {
  test("creates, scans, leaves alone, corrects, and reports; a dry run changes nothing", async () => {
    const alex = await login(USERS.alex);
    const [boss, member] = [await newUser(alex.accessToken, "Boss", { admin: true }), await newUser(alex.accessToken, "Member")];
    const media = mediaFolder("upkeep");
    photos(media.local, ["Pictures/2021.01.01 - Snow/a.jpg", "Pictures/2019.05.05 - Old/b.jpg", "Pictures/Staging/c.jpg", "Videos/Clips/2021.02.02 - Fun/d.jpg"]);
    const folders = [`${media.immich}/Pictures`, `${media.immich}/Videos`];
    const libraries = (since: string) => [
      { account: "boss", name: "Archive", folders },
      {
        account: "member",
        name: "Shared archive",
        folders,
        exclude: [`${media.immich}/Pictures/Staging{,/**}`],
        dated: { since, levels: [`${media.immich}/Pictures`, `${media.immich}/Videos/*`] },
      },
    ];
    const accounts = [
      { name: "boss", user: boss },
      { name: "member", user: member },
    ];
    let config: Config = configFor(dir, accounts, { libraries: libraries("2020-06-15") });
    await loginAccount(config, "boss", boss.password);
    await loginAccount(config, "member", member.password);
    const { open } = await openAccounts(config);
    const [admin, owner] = open as [OpenAccount, OpenAccount];
    const mine = (all: { ownerId: string }[]) => all.filter((library) => library.ownerId === admin.userId || library.ownerId === owner.userId);

    // Not in the cluster group yet: the member's library waits.
    const early = await upkeepLibraries(config, admin, new Set(["boss"]), { dryRun: true });
    expect(early.created).toEqual(["boss/Archive"]);
    expect(early.skipped).toEqual([{ library: "member/Shared archive", reason: "member isn't in the cluster group yet, so its libraries wait" }]);

    const { inGroup } = await joinClusterGroup("boss", open, { dryRun: false });
    const dry = await upkeepLibraries(config, admin, inGroup, { dryRun: true });
    expect(dry.created).toEqual(["boss/Archive", "member/Shared archive"]);
    expect(mine(await listLibraries(admin.client))).toEqual([]);

    const first = await upkeepLibraries(config, admin, inGroup, { dryRun: false });
    // Other tests leave libraries in the development Immich, so `unknown` isn't empty here.
    expect(first).toMatchObject({ created: ["boss/Archive", "member/Shared archive"], updated: [], unchanged: [], skipped: [] });
    expect(first.scanned).toHaveLength(2);
    const [archiveId, sharedId] = first.libraries.map((library) => library.id!);
    expect(await waitForLibraryQueue(admin.client, 60_000, 250)).toBe(true);
    expect(await indexed(admin, archiveId!, media.immich)).toEqual([
      "Pictures/2019.05.05 - Old/b.jpg",
      "Pictures/2021.01.01 - Snow/a.jpg",
      "Pictures/Staging/c.jpg",
      "Videos/Clips/2021.02.02 - Fun/d.jpg",
    ]);
    expect(await indexed(owner, sharedId!, media.immich)).toEqual(["Pictures/2021.01.01 - Snow/a.jpg", "Videos/Clips/2021.02.02 - Fun/d.jpg"]);

    // Nothing changed: nothing to do.
    const second = await upkeepLibraries(config, admin, inGroup, { dryRun: false });
    expect(second).toMatchObject({ created: [], updated: [], unchanged: ["boss/Archive", "member/Shared archive"], scanned: [] });

    // A later cutover: only the shared library's patterns change, and the scan takes the snow photo out.
    config = configFor(dir, accounts, { libraries: libraries("2021-01-15") });
    const third = await upkeepLibraries(config, admin, inGroup, { dryRun: false });
    expect(third).toMatchObject({ updated: ["member/Shared archive"], unchanged: ["boss/Archive"], scanned: [sharedId] });
    const shared = (await listLibraries(admin.client)).find((library) => library.id === sharedId)!;
    expect(new Set(shared.exclusionPatterns)).toEqual(new Set(exclusionsFor(config.immich.libraries[1]!)));
    expect(await waitForLibraryQueue(admin.client, 60_000, 250)).toBe(true);
    expect(await indexed(owner, sharedId!, media.immich)).toEqual(["Videos/Clips/2021.02.02 - Fun/d.jpg"]);

    // A library made by hand is reported, never touched.
    await createLibrary(admin.client, owner.userId, { name: "By hand", importPaths: [`${media.immich}/Pictures`], exclusionPatterns: [] });
    const fourth = await upkeepLibraries(config, admin, inGroup, { dryRun: false });
    expect(fourth.unknown).toContainEqual({ name: "By hand", owner: member.email });
  });

  test("without the admin's session, nothing is done, and every library says why", async () => {
    const config = configFor(dir, [{ name: "boss", user: { ...USERS.alex } }], { libraries: [{ account: "boss", name: "Archive", folders: ["/mnt/media/x"] }] });
    const outcome = await upkeepLibraries(config, undefined, new Set(), { dryRun: false });
    expect(outcome.skipped).toEqual([{ library: "boss/Archive", reason: "the admin account, boss, isn't logged in" }]);
  });
});
