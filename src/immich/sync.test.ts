import { SyncRequestType } from "@immich/sdk";
import { expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, IMMICH_URL, USERS, api, describeImmich, mediaFolder, waitFor } from "../../test/immich/harness.ts";
import { type ImmichClient, ImmichError, login } from "./client.ts";
import { type SyncEvent, acknowledge, batchEvents, checkpoints, forgetCheckpoints, jsonLines, lastAckPerType, syncStream } from "./sync.ts";

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? new TextEncoder().encode(part) : part;
}
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const value of values) all.push(value);
  return all;
}

test("jsonLines splits lines across chunks, multi-byte characters included", async () => {
  const bytes = new TextEncoder().encode('{"name":"Zoë"}\n');
  const split = bytes.indexOf(0xc3) + 1; // inside "ë"
  const lines = await collect(jsonLines(chunks('{"a":1}\n{"b"', ":2}\n\n", bytes.slice(0, split), bytes.slice(split), '{"last":true}')));
  expect(lines).toEqual([{ a: 1 }, { b: 2 }, { name: "Zoë" }, { last: true }]);
});

test("jsonLines throws on a line that isn't JSON", async () => {
  expect(collect(jsonLines(chunks("nope\n")))).rejects.toThrow(SyntaxError);
});

test("lastAckPerType keeps the last ack of each type", () => {
  expect(lastAckPerType(["AssetV2|1", "AssetExifV1|2", "AssetV2|3", "SyncAckV1|4|complete"])).toEqual([
    "AssetV2|3",
    "AssetExifV1|2",
    "SyncAckV1|4|complete",
  ]);
});

const line = (type: string, id: number, data: object = {}) => ({ type, data, ack: `${type}|${id}` });
async function* lines(...values: unknown[]): AsyncGenerator<unknown> {
  yield* values;
}

test("batchEvents groups changes, and acknowledges each batch's last of each type", async () => {
  const batches = await collect(
    batchEvents(
      lines(
        line("AssetV2", 1, { id: "a" }),
        line("AssetV2", 2, { id: "b" }),
        line("AssetExifV1", 3),
        line("AlbumToAssetBackfillV1", 4),
        { type: "SyncAckV1", data: {}, ack: "AlbumToAssetBackfillV1|4|complete" },
        line("SyncCompleteV1", 5),
      ),
      2,
    ),
  );
  expect(batches.map((batch) => batch.events.map((event) => event.type))).toEqual([
    ["AssetV2", "AssetV2"],
    ["AssetExifV1", "AlbumToAssetBackfillV1"],
    // The bookkeeping lines after a full batch: no changes, but acks to send.
    [],
  ]);
  expect(batches[0]).toMatchObject({ acks: ["AssetV2|2"], complete: false, reset: false });
  expect(batches[1]).toMatchObject({ acks: ["AssetExifV1|3", "AlbumToAssetBackfillV1|4"], complete: false });
  expect(batches[2]).toMatchObject({ acks: ["AlbumToAssetBackfillV1|4|complete", "SyncCompleteV1|5"], complete: true });
});

test("batchEvents acknowledges types it doesn't know without passing them on", async () => {
  const [batch] = await collect(batchEvents(lines(line("StackV1", 1), line("AssetV2", 2), line("SyncCompleteV1", 3)), 10));
  expect(batch!.events.map((event) => event.type)).toEqual(["AssetV2"]);
  expect(batch!.acks).toEqual(["StackV1|1", "AssetV2|2", "SyncCompleteV1|3"]);
});

test("a reset is a batch of its own, with only the reset's ack", async () => {
  const batches = await collect(batchEvents(lines({ type: "SyncResetV1", data: {}, ack: "SyncResetV1|reset" }), 10));
  expect(batches).toEqual([{ events: [], acks: ["SyncResetV1|reset"], reset: true, complete: false }]);
});

test("a stream cut off before SyncCompleteV1 still hands on what arrived", async () => {
  const batches = await collect(batchEvents(lines(line("AssetV2", 1)), 10));
  expect(batches).toEqual([{ events: [line("AssetV2", 1)] as never, acks: ["AssetV2|1"], reset: false, complete: false }]);
  expect(await collect(batchEvents(lines(), 10))).toEqual([]);
});

test("a line without a type or ack is an error", async () => {
  expect(collect(batchEvents(lines({ data: {} }), 10))).rejects.toThrow("a line without a type or an ack");
});

describeImmich("the sync stream, against Immich", () => {
  type Events = { [T in SyncEvent["type"]]?: Extract<SyncEvent, { type: T }>["data"][] };

  /** Reads a whole stream, acknowledging each batch, and returns its changes by type. */
  async function readAll(client: ImmichClient): Promise<{ events: Events; reset: boolean; batches: number }> {
    const events: Events = {};
    let reset = false;
    let batches = 0;
    for await (const batch of syncStream(client, { batchSize: 2 })) {
      batches++;
      for (const event of batch.events) ((events[event.type] ??= []) as unknown[]).push(event.data);
      reset ||= batch.reset;
      await acknowledge(client, batch.acks);
    }
    return { events, reset, batches };
  }

  test("reports changes once each, follows acknowledgements, and resets", async () => {
    const admin = await login(IMMICH_URL, USERS.alex.email, USERS.alex.password);
    const sam = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
    const folder = mediaFolder("sync");
    for (const name of ["a.jpg", "b.jpg", "c.jpg"]) copyFileSync(join(FIXTURES, "photo.jpg"), join(folder.local, name));
    const library = await api<{ id: string }>("POST", "/libraries", {
      token: admin.token,
      body: { ownerId: sam.userId, name: "sync test", importPaths: [folder.immich], exclusionPatterns: [] },
    });
    await api("POST", `/libraries/${library.id}/scan`, { token: admin.token });
    await waitFor("the scan", async () => {
      const { assets } = await api<{ assets: { items: { exifInfo?: { dateTimeOriginal?: string } }[] } }>("POST", "/search/metadata", {
        token: sam.token,
        body: { filter: { libraryId: { eq: library.id } }, withExif: true },
      });
      return assets.items.length === 3 && assets.items.every((asset) => asset.exifInfo?.dateTimeOriginal) ? true : undefined;
    });

    // A new session gets everything, once.
    const first = await readAll(sam.client);
    const ours = (first.events.AssetV2 ?? []).filter((asset) => asset.libraryId === library.id);
    expect(ours.map((asset) => asset.originalFileName).sort()).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(ours.every((asset) => asset.ownerId === sam.userId && !asset.isFavorite && asset.deletedAt === null)).toBe(true);
    const ids = Object.fromEntries(ours.map((asset) => [asset.originalFileName, asset.id])) as Record<"a.jpg" | "b.jpg" | "c.jpg", string>;
    const exifs = (first.events.AssetExifV1 ?? []).filter((exif) => Object.values(ids).includes(exif.assetId));
    expect(exifs).toHaveLength(3);
    expect(exifs[0]!.dateTimeOriginal).toStartWith("2021-06-15");
    expect(first.batches).toBeGreaterThan(1);
    expect((await readAll(sam.client)).events).toEqual({});

    // Favorite one, trash another, put the third in an album and give it a named face.
    await api("PUT", "/assets", { token: sam.token, body: { ids: [ids["a.jpg"]], isFavorite: true } });
    await api("DELETE", "/assets", { token: sam.token, body: { ids: [ids["b.jpg"]] } });
    const album = await api<{ id: string }>("POST", "/albums", { token: sam.token, body: { albumName: "Sync test", assetIds: [ids["c.jpg"]] } });
    const person = await api<{ id: string }>("POST", "/people", { token: sam.token, body: { name: "Robin Example" } });
    await api("POST", "/faces", {
      token: sam.token,
      body: { assetId: ids["c.jpg"], personId: person.id, imageWidth: 96, imageHeight: 64, x: 10, y: 10, width: 20, height: 20 },
    });
    // Immich's jobs then update the person (its face and thumbnail): let them finish, or they show up as later changes.
    await waitFor("the person's thumbnail", async () => {
      const current = await api<{ thumbnailPath: string }>("GET", `/people/${person.id}`, { token: sam.token });
      return current.thumbnailPath ? true : undefined;
    });

    const second = await readAll(sam.client);
    const changed = Object.fromEntries((second.events.AssetV2 ?? []).map((asset) => [asset.id, asset]));
    expect(changed[ids["a.jpg"]]?.isFavorite).toBe(true);
    expect(changed[ids["b.jpg"]]?.deletedAt).not.toBeNull();
    expect(second.events.AlbumV2?.map((value) => value.id)).toEqual([album.id]);
    expect(second.events.AlbumToAssetV1).toEqual([{ albumId: album.id, assetId: ids["c.jpg"] }]);
    expect(second.events.PersonV1?.find((value) => value.id === person.id)?.name).toBe("Robin Example");
    expect(second.events.AssetFaceV3).toMatchObject([{ assetId: ids["c.jpg"], personId: person.id, deletedAt: null, isVisible: true }]);
    expect((await readAll(sam.client)).events).toEqual({});

    // A reset comes alone; acknowledging it clears the checkpoints, and the next stream sends everything again.
    expect((await checkpoints(sam.client)).length).toBeGreaterThan(0);
    const sessions = await api<{ id: string; current: boolean }[]>("GET", "/sessions", { token: sam.token });
    await api("PUT", `/sessions/${sessions.find((session) => session.current)!.id}`, { token: sam.token, body: { isPendingSyncReset: true } });
    expect(await readAll(sam.client)).toEqual({ events: {}, reset: true, batches: 1 });
    expect(await checkpoints(sam.client)).toEqual([]);
    const again = await readAll(sam.client);
    expect(again.events.AssetV2?.filter((asset) => asset.libraryId === library.id)).toHaveLength(3);

    await forgetCheckpoints(sam.client);
    expect(await checkpoints(sam.client)).toEqual([]);
  });

  test("Immich 3.3 refuses AssetsV1, and the error says so", async () => {
    const sam = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
    const error = await collect(syncStream(sam.client, { types: [SyncRequestType.AssetsV1] })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImmichError);
    expect((error as ImmichError).status).toBe(400);
    expect((error as ImmichError).message).toContain("AssetsV1 is deprecated");
  });

  test("a revoked session is a 401", async () => {
    const sam = await login(IMMICH_URL, USERS.sam.email, USERS.sam.password);
    await sam.client.logout();
    const error = await collect(syncStream(sam.client)).catch((caught: unknown) => caught);
    expect((error as ImmichError).status).toBe(401);
  });

});
