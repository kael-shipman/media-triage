import { beforeAll, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, IMMICH_URL, USERS, describeImmich, mediaFolder, waitFor } from "../../test/immich/harness.ts";
import { libraryPages } from "./assets.ts";
import { type ImmichClient, ImmichError, type LoginResult, login } from "./client.ts";
import { createLibrary, libraryStatistics, listLibraries, listUsers, scanLibrary, updateLibrary, validateImportPaths } from "./libraries.ts";

test("lists Immich would refuse are refused before sending, naming the library", async () => {
  const client = { call: () => Promise.reject(new Error("not sent")) } as unknown as ImmichClient;
  const tooMany = Array.from({ length: 129 }, (_, index) => `/x/${index}`);
  expect(() => createLibrary(client, "owner", { name: "Big", importPaths: ["/a"], exclusionPatterns: tooMany })).toThrow(
    'Library "Big": 129 exclusion patterns, but Immich allows at most 128',
  );
  expect(() => createLibrary(client, "owner", { name: "Twice", importPaths: ["/a", "/a"], exclusionPatterns: [] })).toThrow(ImmichError);
  expect(() => createLibrary(client, "owner", { name: "Empty", importPaths: [" "], exclusionPatterns: [] })).toThrow("an empty item");
});

describeImmich("libraries, against Immich", () => {
  let admin: LoginResult;
  let sam: LoginResult;
  beforeAll(async () => {
    admin = await login(IMMICH_URL, USERS.alex.email, USERS.alex.password);
    sam = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
  });

  async function assetPaths(client: ImmichClient, libraryId: string): Promise<string[]> {
    const paths: string[] = [];
    for await (const page of libraryPages(client, libraryId)) paths.push(...page.filter((asset) => !asset.isOffline).map((asset) => asset.originalPath));
    return paths.sort();
  }

  test("the admin creates, corrects and scans another account's library", async () => {
    const folder = mediaFolder("libraries");
    for (const name of ["keep.jpg", "skip.jpg"]) copyFileSync(join(FIXTURES, "photo.jpg"), join(folder.local, name));

    const library = await createLibrary(admin.client, sam.userId, { name: "Libraries test", importPaths: [folder.immich], exclusionPatterns: ["**/skip.jpg"] });
    expect(library).toMatchObject({ ownerId: sam.userId, importPaths: [folder.immich], exclusionPatterns: ["**/skip.jpg"] });
    expect((await listLibraries(admin.client)).map((found) => found.id)).toContain(library.id);

    await scanLibrary(admin.client, library.id);
    await waitFor("the first scan", async () => ((await assetPaths(sam.client, library.id)).length === 1 ? true : undefined));
    expect(await assetPaths(sam.client, library.id)).toEqual([`${folder.immich}/keep.jpg`]);

    const updated = await updateLibrary(admin.client, library.id, { exclusionPatterns: [] });
    expect(updated.exclusionPatterns).toEqual([]);
    expect(updated.name).toBe("Libraries test");
    await scanLibrary(admin.client, library.id);
    await waitFor("the second scan", async () => ((await assetPaths(sam.client, library.id)).length === 2 ? true : undefined));
    expect((await libraryStatistics(admin.client, library.id)).photos).toBe(2);
  });

  test("two accounts' libraries can index the same folder, each with its own assets", async () => {
    const folder = mediaFolder("shared");
    copyFileSync(join(FIXTURES, "photo.jpg"), join(folder.local, "both.jpg"));
    const settings = { name: "Same folder", importPaths: [folder.immich], exclusionPatterns: [] };
    const [mine, theirs] = [await createLibrary(admin.client, admin.userId, settings), await createLibrary(admin.client, sam.userId, settings)];
    await Promise.all([scanLibrary(admin.client, mine.id), scanLibrary(admin.client, theirs.id)]);
    const ids = await waitFor("both scans", async () => {
      const [a, b] = await Promise.all([assetIds(admin.client, mine.id), assetIds(sam.client, theirs.id)]);
      return a.length === 1 && b.length === 1 ? [a[0], b[0]] : undefined;
    });
    expect(ids[0]).not.toBe(ids[1]);
  });

  async function assetIds(client: ImmichClient, libraryId: string): Promise<string[]> {
    const ids: string[] = [];
    for await (const page of libraryPages(client, libraryId)) ids.push(...page.map((asset) => asset.id));
    return ids;
  }

  test("folders are checked as Immich sees them", async () => {
    const folder = mediaFolder("validate");
    const library = await createLibrary(admin.client, sam.userId, { name: "Validate test", importPaths: [folder.immich], exclusionPatterns: [] });
    const results = await validateImportPaths(admin.client, library.id, [folder.immich, "/mnt/media/no-such-folder"]);
    expect(results.map((result) => result.isValid)).toEqual([true, false]);
  });

  test("only the admin can manage libraries; users are listed with their IDs", async () => {
    const error = await listLibraries(sam.client).catch((caught: unknown) => caught);
    expect((error as ImmichError).status).toBe(403);
    const users = await listUsers(admin.client);
    expect(users.find((user) => user.email === USERS.sam.email)?.id).toBe(sam.userId);
  });
});
