// Makes the sidecar fixtures with the tools themselves, from photo.jpg (made up, dated 2021-06-15), with made-up
// values only:
//
//   bun test/fixtures/make.ts darktable   # darktable.xmp: Darktable 5.6, headless, with a throwaway library
//   bun test/fixtures/make.ts immich      # immich.xmp: the development Immich (`bun run immich up` first)
//
// Each is the sidecar the tool writes from scratch when someone edits a photo that has none.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { darktable } from "../darktable.ts";
import { USERS, api, indexedLibrary, login, waitFor } from "../immich/harness.ts";

const fixtures = import.meta.dir;

async function makeDarktable(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "media-triage-fixture-"));
  try {
    const photo = join(dir, "photo.jpg");
    copyFileSync(join(fixtures, "photo.jpg"), photo);
    await darktable(
      photo,
      `image.rating = 3
  image.title = "Lake day"
  image.description = "A day by the lake"
  image.creator = "Alex Example"
  image.latitude = 12.5
  image.longitude = -3.25
  dt.tags.attach(dt.tags.create("Places|Lake"), image)
  dt.tags.attach(dt.tags.create("People|Robin Example"), image)`,
    );
    copyFileSync(`${photo}.xmp`, join(fixtures, "darktable.xmp"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function makeImmich(): Promise<void> {
  const alex = await login(USERS.alex);
  const token = alex.accessToken;
  const library = await indexedLibrary("fixture", { token }, { token, userId: alex.userId }, ["photo.jpg"]);
  const asset = library.assets["photo.jpg"]!;
  await api("PUT", `/assets/${asset.id}`, {
    token,
    body: { rating: 4, description: "A day by the lake", latitude: 12.5, longitude: -3.25, dateTimeOriginal: "2021-06-15T10:20:30.000+02:00" },
  });
  const [tag] = await api<{ id: string }[]>("PUT", "/tags", { token, body: { tags: ["Places/Lake"] } });
  await api("PUT", `/tags/${tag!.id}/assets`, { token, body: { ids: [asset.id] } });
  // Immich writes the sidecar in its own jobs, once per change: wait for the last.
  const sidecar = join(library.folder.local, "photo.jpg.xmp");
  await waitFor("Immich's sidecar", async () => {
    if (!existsSync(sidecar)) return undefined;
    const text = await Bun.file(sidecar).text();
    return text.includes("Places/Lake") && text.includes("A day by the lake") && text.includes("2021-06-15T10:20:30") ? true : undefined;
  });
  copyFileSync(sidecar, join(fixtures, "immich.xmp"));
}

const which = process.argv[2];
if (which === "darktable") await makeDarktable();
else if (which === "immich") await makeImmich();
else throw new Error("Which fixture? darktable or immich");
console.log(`Wrote test/fixtures/${which}.xmp`);
