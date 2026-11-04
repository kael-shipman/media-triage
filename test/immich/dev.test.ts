// Checks the development Immich itself: its users, its settings, and that a library over the media folder indexes
// files at the paths Immich sees them at.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, USERS, api, describeImmich, login, mediaFolder, waitFor } from "./harness.ts";

describeImmich("the development Immich", () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  test("runs 3.3, with both users, and machine learning off", async () => {
    expect(await api("GET", "/server/version")).toMatchObject({ major: 3, minor: 3 });
    const admin = await login(USERS.alex);
    const sam = await login(USERS.sam);
    expect(sam.userId).not.toBe(admin.userId);
    const config = await api<{ machineLearning: { enabled: boolean } }>("GET", "/system-config", { token: admin.accessToken });
    expect(config.machineLearning.enabled).toBe(false);
  });

  test("a library over the media folder indexes its files", async () => {
    const { accessToken: token, userId } = await login(USERS.alex);
    const folder = mediaFolder("dev");
    copyFileSync(join(FIXTURES, "photo.jpg"), join(folder.local, "photo.jpg"));

    const library = await api<{ id: string }>("POST", "/libraries", {
      token,
      body: { ownerId: userId, name: "dev check", importPaths: [folder.immich], exclusionPatterns: [] },
    });
    cleanups.push(() => api("DELETE", `/libraries/${library.id}`, { token }));
    await api("POST", `/libraries/${library.id}/scan`, { token });

    type Asset = { originalPath: string; exifInfo?: { dateTimeOriginal?: string } };
    const asset = await waitFor("the scan, and the metadata extraction", async () => {
      const { assets } = await api<{ assets: { items: Asset[] } }>("POST", "/search/metadata", {
        token,
        body: { filter: { libraryId: { eq: library.id } }, withExif: true },
      });
      const found = assets.items[0];
      return found?.exifInfo?.dateTimeOriginal ? found : undefined;
    });
    expect(asset.originalPath).toBe(`${folder.immich}/photo.jpg`);
    expect(asset.exifInfo!.dateTimeOriginal).toStartWith("2021-06-15T10:20:30");
  });
});
