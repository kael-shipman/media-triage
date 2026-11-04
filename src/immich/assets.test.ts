import { AssetVisibility } from "@immich/sdk";
import { beforeAll, expect, test } from "bun:test";
import { copyFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, IMMICH_URL, USERS, api, describeImmich, mediaFolder, waitFor } from "../../test/immich/harness.ts";
import {
  type Asset,
  chunks,
  findByPaths,
  getAsset,
  libraryPages,
  refreshMetadata,
  restoreAssets,
  setFavorite,
  setVisibility,
  trashAssets,
} from "./assets.ts";
import { type ImmichClient, login } from "./client.ts";

test("chunks splits a list into pieces of at most the size", () => {
  expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunks([], 2)).toEqual([]);
});

/** A minimal XMP sidecar with a description. */
const sidecar = (description: string) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${description}</rdf:li></rdf:Alt></dc:description>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

describeImmich("assets, against Immich", () => {
  const names = ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"];
  let client: ImmichClient;
  let adminToken: string;
  let folder: { local: string; immich: string };
  let libraryId: string;
  let byName: Record<string, Asset>;

  /** Scans the library, and waits until `ready` holds for what the search returns. */
  async function scan(ready: (assets: Asset[]) => boolean): Promise<Asset[]> {
    await api("POST", `/libraries/${libraryId}/scan`, { token: adminToken });
    return waitFor("the scan", async () => {
      const assets: Asset[] = [];
      for await (const page of libraryPages(client, libraryId)) assets.push(...page);
      return ready(assets) ? assets : undefined;
    });
  }
  beforeAll(async () => {
    const alex = await login(IMMICH_URL, USERS.alex.email, USERS.alex.password);
    const sam = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
    adminToken = alex.token;
    client = sam.client;
    folder = mediaFolder("assets");
    for (const name of names) copyFileSync(join(FIXTURES, "photo.jpg"), join(folder.local, name));
    // a.jpg has a sidecar from the start.
    writeFileSync(join(folder.local, "a.jpg.xmp"), sidecar("First"));
    ({ id: libraryId } = await api<{ id: string }>("POST", "/libraries", {
      token: adminToken,
      body: { ownerId: sam.userId, name: "assets test", importPaths: [folder.immich], exclusionPatterns: [] },
    }));
    const assets = await scan((found) => found.length === names.length);
    byName = Object.fromEntries(assets.map((asset) => [asset.originalFileName, asset]));
  });

  test("a library is listed a page at a time, each asset once, with Immich's paths", async () => {
    const pages: Asset[][] = [];
    for await (const page of libraryPages(client, libraryId, { pageSize: 2 })) pages.push(page);
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    const paths = pages.flat().map((asset) => asset.originalPath);
    expect(new Set(paths).size).toBe(names.length);
    expect(paths.sort()).toEqual(names.map((name) => `${folder.immich}/${name}`));
  });

  test("assets are found by path, in bulk; unknown paths and IDs find nothing", async () => {
    const found = await findByPaths(client, [`${folder.immich}/a.jpg`, `${folder.immich}/c.jpg`, `${folder.immich}/nope.jpg`]);
    expect(found.map((asset) => asset.originalFileName).sort()).toEqual(["a.jpg", "c.jpg"]);
    expect((await getAsset(client, byName["a.jpg"]!.id))?.originalPath).toBe(`${folder.immich}/a.jpg`);
    expect(await getAsset(client, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  test("a metadata refresh re-reads a sidecar Immich already knows", async () => {
    const id = byName["a.jpg"]!.id;
    await waitFor("the first description", async () => ((await getAsset(client, id))?.exifInfo?.description === "First" ? true : undefined));
    writeFileSync(join(folder.local, "a.jpg.xmp"), sidecar("Second"));
    await refreshMetadata(client, [id]);
    await waitFor("the new description", async () => ((await getAsset(client, id))?.exifInfo?.description === "Second" ? true : undefined));
  });

  test("but not a sidecar that appeared after the asset was indexed (stock Immich 3.3.5)", async () => {
    const id = byName["b.jpg"]!.id;
    writeFileSync(join(folder.local, "b.jpg.xmp"), sidecar("Late"));
    await refreshMetadata(client, [id]);
    await Bun.sleep(3000);
    expect((await getAsset(client, id))?.exifInfo?.description).toBe("");
  });

  test("trash and restore, favorite and visibility, in bulk", async () => {
    const [c, d] = [byName["c.jpg"]!.id, byName["d.jpg"]!.id];
    await trashAssets(client, [c, d]);
    expect((await getAsset(client, c))?.isTrashed).toBe(true);
    await restoreAssets(client, [c, d]);
    expect((await getAsset(client, d))?.isTrashed).toBe(false);

    await setFavorite(client, [c, d], true);
    expect((await getAsset(client, c))?.isFavorite).toBe(true);
    await setFavorite(client, [c], false);
    expect((await getAsset(client, c))?.isFavorite).toBe(false);

    await setVisibility(client, [d], AssetVisibility.Archive);
    expect((await getAsset(client, d))?.visibility).toBe(AssetVisibility.Archive);
    await setVisibility(client, [d], AssetVisibility.Timeline);
    expect((await getAsset(client, d))?.visibility).toBe(AssetVisibility.Timeline);
  });

  test("a locked asset is left out of searches, and reads like a missing one without the PIN", async () => {
    const id = byName["d.jpg"]!.id;
    await setVisibility(client, [id], AssetVisibility.Locked);
    const listed: Asset[] = [];
    for await (const page of libraryPages(client, libraryId)) listed.push(...page);
    expect(listed.map((asset) => asset.id)).not.toContain(id);
    expect(await getAsset(client, id)).toBeUndefined();
  });

  test("a file that goes missing is offline and trashed; when it comes back, it's neither", async () => {
    const id = byName["e.jpg"]!.id;
    renameSync(join(folder.local, "e.jpg"), join(folder.local, "..", "e.jpg.away"));
    await scan((assets) => assets.find((asset) => asset.id === id)?.isOffline === true);
    expect(await getAsset(client, id)).toMatchObject({ isOffline: true, isTrashed: true });
    renameSync(join(folder.local, "..", "e.jpg.away"), join(folder.local, "e.jpg"));
    await scan((assets) => assets.find((asset) => asset.id === id)?.isOffline === false);
    expect(await getAsset(client, id)).toMatchObject({ isOffline: false, isTrashed: false });
  });
});
