import { beforeAll, expect, test } from "bun:test";
import { IMMICH_URL, type IndexedLibrary, USERS, describeImmich, indexedLibrary } from "../../test/immich/harness.ts";
import { addToAlbum, createAlbum, listAlbums, removeFromAlbum } from "./albums.ts";
import { type ImmichClient, login } from "./client.ts";

describeImmich("albums, against Immich", () => {
  let client: ImmichClient;
  let library: IndexedLibrary;
  beforeAll(async () => {
    const admin = await login(IMMICH_URL, USERS.alex.email, USERS.alex.password);
    const sam = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
    client = sam.client;
    library = await indexedLibrary("albums", admin, sam, ["a.jpg", "b.jpg", "c.jpg"]);
  });

  test("assets go in and out in bulk, and doing it twice is fine", async () => {
    const [a, b, c] = ["a.jpg", "b.jpg", "c.jpg"].map((name) => library.assets[name]!.id) as [string, string, string];
    const album = await createAlbum(client, "Albums test", [a]);
    expect(album.assetCount).toBe(1);

    expect(await addToAlbum(client, album.id, [a, b])).toEqual([]);
    expect((await listAlbums(client, { assetId: b })).map((found) => found.id)).toContain(album.id);
    expect(await addToAlbum(client, album.id, [b])).toEqual([]);

    expect(await removeFromAlbum(client, album.id, [b, c])).toEqual([]);
    expect((await listAlbums(client, { assetId: b })).map((found) => found.id)).not.toContain(album.id);
    expect((await listAlbums(client)).find((found) => found.id === album.id)?.assetCount).toBe(1);
  });

  test("an asset of another account can't be added, and is reported", async () => {
    const alex = await login(IMMICH_URL, USERS.alex.email, USERS.alex.password);
    const album = await createAlbum(alex.client, "Not Sam's assets");
    const failed = await addToAlbum(alex.client, album.id, [library.assets["a.jpg"]!.id]);
    expect(failed).toEqual([{ id: library.assets["a.jpg"]!.id, reason: "no_permission" }]);
  });
});
