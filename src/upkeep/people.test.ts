import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USERS, api, configFor, describeImmich, login, mediaFolder, newUser, photos } from "../../test/immich/harness.ts";
import { libraryPages } from "../immich/assets.ts";
import { login as signIn } from "../immich/client.ts";
import { createFace } from "../immich/faces.ts";
import { createLibrary, scanLibrary, waitForLibraryQueue } from "../immich/libraries.ts";
import { loginAccount } from "../immich/login.ts";
import { loadSession } from "../immich/sessions.ts";
import { createPerson, getPerson, listPeopleShares } from "../immich/people.ts";
import { type OpenAccount, openAccounts } from "./accounts.ts";
import { joinClusterGroup } from "./cluster.ts";
import { upkeepPeople } from "./people.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describeImmich("people upkeep, against Immich", () => {
  test("shares people both ways, names records left unnamed, and has nothing to do the second time", async () => {
    const alex = await login(USERS.alex);
    const [first, second] = [await newUser(alex.accessToken, "First"), await newUser(alex.accessToken, "Second")];
    const config = configFor(dir, [
      { name: "first", user: first },
      { name: "second", user: second },
    ]);
    await loginAccount(config, "first", first.password);
    await loginAccount(config, "second", second.password);
    const tokens = { one: loadSession(dir, "first")!.token, two: loadSession(dir, "second")!.token };
    const { open } = await openAccounts(config);
    const [one, two] = open as [OpenAccount, OpenAccount];
    await joinClusterGroup("first", open, { dryRun: false });

    // Both accounts index the same photo.
    const media = mediaFolder("people");
    photos(media.local, ["a.jpg"]);
    const admin = await signIn(config.immich.url!, USERS.alex.email, USERS.alex.password);
    const assetOf = async (account: OpenAccount) => {
      const library = await createLibrary(admin.client, account.userId, { name: "People test", importPaths: [media.immich], exclusionPatterns: [] });
      await scanLibrary(admin.client, library.id);
      expect(await waitForLibraryQueue(admin.client, 60_000, 250)).toBe(true);
      for await (const page of libraryPages(account.client, library.id)) return page[0]!.id;
      throw new Error("not indexed");
    };
    const [assetOne, assetTwo] = [await assetOf(one), await assetOf(two)];
    const box = { imageWidth: 96, imageHeight: 64, x: 10, y: 10, width: 30, height: 30 };
    const nameIn = async (account: OpenAccount, id: string) => (await getPerson(account.client, id))?.name;

    // The first account has a person, not yet named. A dry run shares nothing; a live one shares it.
    const robin = await createPerson(one.client, "");
    await createFace(one.client, { assetId: assetOne, personId: robin.id, ...box });
    expect(await upkeepPeople(open, { dryRun: true })).toEqual({ shared: ["first", "second"], named: [], conflicts: [] });
    expect(await listPeopleShares(one.client)).toEqual([]);
    await upkeepPeople(open, { dryRun: false });
    expect(await listPeopleShares(one.client)).toContainEqual(expect.objectContaining({ personId: robin.id, sharedWithId: two.userId, role: "write" }));

    // The second account has the person on its copy too (one face: too few to be listed while unnamed), and shares
    // it back.
    await createFace(two.client, { assetId: assetTwo, personId: robin.id, ...box });
    await upkeepPeople(open, { dryRun: false });
    expect(await listPeopleShares(two.client)).toContainEqual(expect.objectContaining({ personId: robin.id, sharedWithId: one.userId, role: "write" }));

    // A name set on the first account's record alone isn't on the second's: upkeep copies it.
    await api("PUT", `/people/${robin.id}`, { token: tokens.one, body: { name: "Robin Example", userId: one.userId } });
    expect(await nameIn(two, robin.id)).toBe("");
    expect((await upkeepPeople(open, { dryRun: true })).named).toEqual(["second: Robin Example"]);
    expect(await nameIn(two, robin.id)).toBe("");
    expect(await upkeepPeople(open, { dryRun: false })).toEqual({ shared: ["first", "second"], named: ["second: Robin Example"], conflicts: [] });
    expect(await nameIn(two, robin.id)).toBe("Robin Example");
    expect((await upkeepPeople(open, { dryRun: false })).named).toEqual([]);

    // From then on, Immich keeps names in step itself: a rename reaches the records shared with write access.
    await api("PUT", `/people/${robin.id}`, { token: tokens.two, body: { name: "Robin B. Example" } });
    expect(await nameIn(one, robin.id)).toBe("Robin B. Example");

    // Two different names: neither is copied, and it's reported.
    await api("PUT", `/people/${robin.id}`, { token: tokens.one, body: { name: "Robyn Example", userId: one.userId } });
    expect((await upkeepPeople(open, { dryRun: false })).conflicts).toEqual([{ personId: robin.id, names: ["Robin B. Example", "Robyn Example"] }]);
  });
});
