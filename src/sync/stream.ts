// One account's sync stream, consumed (DESIGN.md, sections 3 and 13): each batch's assets are recorded with their
// paths, the units they belong to are handed to `act` (the reconcile), and only then is the batch acknowledged, so a
// change is never acknowledged before it's acted on. A restart resumes where the last acknowledgement left off.

import { type Asset, getAsset, libraryPages, searchPages } from "../immich/assets.ts";
import { acknowledge, type SyncEvent, syncStream } from "../immich/sync.ts";
import type { PathMap } from "../core/path-map.ts";
import { log } from "../log.ts";
import type { OpenAccount } from "../upkeep/accounts.ts";
import type { AssetRecord, FaceRecord, SyncStore } from "./store.ts";

/** Past this many unknown assets in a batch, their libraries are listed whole rather than each asset read alone. */
export const BULK_LOOKUP = 50;

export interface StreamOptions {
  /** Called with each batch's changed units (local media paths), before the batch is acknowledged. */
  act: (units: string[]) => Promise<void>;
  batchSize?: number;
  bulkLookup?: number;
  /** Read and act, but acknowledge nothing, so a later live run sees every change. */
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface StreamOutcome {
  batches: number;
  events: number;
  /** The server asked for a reset: the account's assets were forgotten, and its stream must be read again. */
  reset: boolean;
}

/** The asset events that can change what a unit should say. Faces and people are handled by `recordAlbumsAndFaces`. */
function assetOf(event: SyncEvent): string | undefined {
  switch (event.type) {
    case "AssetV2":
      return event.data.id;
    case "AssetExifV1":
      return event.data.assetId;
    case "AlbumToAssetV1":
    case "AlbumToAssetBackfillV1":
    case "AlbumToAssetDeleteV1":
      return event.data.assetId;
    default:
      return undefined;
  }
}

/**
 * The account's own assets among these. An account can also read others' assets, such as those in an album shared
 * with it, but each asset is recorded with its owner's account, whose session changes it.
 */
const own = (account: OpenAccount, assets: readonly Asset[]) => assets.filter((asset) => asset.ownerId === account.userId);

function record(account: OpenAccount, map: PathMap, asset: Asset): AssetRecord {
  return {
    id: asset.id,
    account: account.account.name,
    owner: asset.ownerId,
    library: asset.libraryId ?? null,
    path: asset.originalPath,
    local: map.toLocal(asset.originalPath) ?? null,
    trashed: asset.isTrashed,
    visibility: asset.visibility,
    favorite: asset.isFavorite,
  };
}

/**
 * Learns the paths of assets the store doesn't know: in bulk, a library at a time, when there are many (a first run,
 * a reset, a new library's first scan), or one at a time otherwise. An asset Immich won't show (gone, or locked
 * without the account's PIN) stays unknown.
 */
export async function learnAssets(
  account: OpenAccount,
  store: SyncStore,
  map: PathMap,
  unknown: { id: string; library: string | null }[],
  bulkLookup = BULK_LOOKUP,
): Promise<void> {
  const wanted = new Set(unknown.map((asset) => asset.id));
  if (wanted.size === 0) return;
  if (wanted.size > bulkLookup) {
    const libraries = new Set(unknown.flatMap((asset) => (asset.library ? [asset.library] : [])));
    for (const library of libraries) {
      for await (const page of libraryPages(account.client, library)) {
        store.putAssets(own(account, page).map((asset) => record(account, map, asset)));
        for (const asset of page) wanted.delete(asset.id);
      }
    }
  }
  const found: AssetRecord[] = [];
  for (const id of wanted) {
    const asset = await getAsset(account.client, id);
    if (asset) found.push(...own(account, [asset]).map((asset) => record(account, map, asset)));
  }
  store.putAssets(found);
}

/** Learns every asset of the account, a page at a time: after a reset, or on a first run. */
export async function learnAllAssets(account: OpenAccount, store: SyncStore, map: PathMap): Promise<number> {
  let count = 0;
  for await (const page of searchPages(account.client, {})) {
    const mine = own(account, page);
    store.putAssets(mine.map((asset) => record(account, map, asset)));
    count += mine.length;
  }
  return count;
}

/** Reads the account's stream to its end, acting on and acknowledging each batch. */
export async function consumeStream(account: OpenAccount, store: SyncStore, map: PathMap, options: StreamOptions): Promise<StreamOutcome> {
  const outcome: StreamOutcome = { batches: 0, events: 0, reset: false };
  for await (const batch of syncStream(account.client, { batchSize: options.batchSize, signal: options.signal })) {
    if (batch.reset) {
      // Acknowledging the reset clears the session's checkpoints; the next read sends everything.
      if (!options.dryRun) await acknowledge(account.client, batch.acks);
      store.forgetAccount(account.account.name);
      log.warn("Immich reset the account's sync stream; reading the whole account again", { account: account.account.name });
      outcome.reset = true;
      return outcome;
    }
    outcome.batches++;
    outcome.events += batch.events.length;

    // Record what the stream says about assets, and learn the paths of new ones. Only the account's own assets are
    // learned: other events can name others' assets (in a shared album), which their own account's stream reports.
    const unknown = new Map<string, string | null>();
    const changes: { id: string; trashed: boolean; visibility: string; favorite: boolean }[] = [];
    const deleted: string[] = [];
    const ownIds = new Set<string>();
    for (const event of batch.events) {
      if (event.type === "AssetDeleteV1") deleted.push(event.data.assetId);
      if (event.type === "AssetExifV1") ownIds.add(event.data.assetId);
      if (event.type !== "AssetV2") continue;
      ownIds.add(event.data.id);
      changes.push({ id: event.data.id, trashed: event.data.deletedAt !== null, visibility: event.data.visibility, favorite: event.data.isFavorite });
      if (!store.asset(event.data.id)) unknown.set(event.data.id, event.data.libraryId);
    }
    for (const id of store.unknownAssets([...ownIds])) if (!unknown.has(id)) unknown.set(id, null);
    await learnAssets(account, store, map, [...unknown].map(([id, library]) => ({ id, library })), options.bulkLookup);
    store.updateAssets(changes);

    // Albums (F9), faces and people (F10): a renamed or lost album, or a renamed or hidden person, changes every
    // sidecar that names them.
    const touched = recordAlbumsAndFaces(account.account.name, store, batch.events);
    if (batch.complete) touched.push(...(store.sweep(account.account.name) ?? []));

    // The units those assets belong to, here. Deleted assets' units are acted on too: their copy is gone.
    const ids = [...new Set(batch.events.flatMap((event) => assetOf(event) ?? []))];
    const units = new Set<string>();
    for (const id of [...ids, ...deleted, ...touched]) {
      const local = store.asset(id)?.local;
      if (local) units.add(local);
    }
    store.removeAssets(deleted);
    await options.act([...units].sort());
    if (!options.dryRun) await acknowledge(account.client, batch.acks);
  }
  return outcome;
}

/**
 * Records a batch's album, people and face events, in order. Returns the assets they change: those in albums renamed
 * or gone, with faces of people renamed, hidden, shown or gone, and those whose faces changed. Faces come many at a
 * time on a first run, so consecutive ones are recorded together.
 */
function recordAlbumsAndFaces(account: string, store: SyncStore, events: readonly SyncEvent[]): string[] {
  const touched: string[] = [];
  let faces: FaceRecord[] = [];
  const flushFaces = () => {
    store.putFaces(faces);
    faces = [];
  };
  for (const event of events) {
    if (event.type !== "AssetFaceV3" && faces.length > 0) flushFaces();
    switch (event.type) {
      case "AssetFaceV3": {
        const face = event.data;
        faces.push({
          id: face.id,
          asset: face.assetId,
          person: face.personId,
          boundingBoxX1: face.boundingBoxX1,
          boundingBoxY1: face.boundingBoxY1,
          boundingBoxX2: face.boundingBoxX2,
          boundingBoxY2: face.boundingBoxY2,
          imageWidth: face.imageWidth,
          imageHeight: face.imageHeight,
          source: face.sourceType,
          visible: face.isVisible,
          deleted: face.deletedAt,
        });
        touched.push(face.assetId);
        break;
      }
      case "AssetFaceDeleteV1":
        touched.push(...store.removeFaces([event.data.assetFaceId]));
        break;
      case "PersonV1":
        for (const id of store.putPeople([{ account, id: event.data.id, name: event.data.name, hidden: event.data.isHidden }])) {
          touched.push(...store.assetsWithPerson(id));
        }
        break;
      case "PersonDeleteV1":
        touched.push(...store.assetsWithPerson(event.data.personId));
        store.removePerson(account, event.data.personId);
        break;
      case "AlbumV2":
        for (const album of store.putAlbums(account, [{ id: event.data.id, name: event.data.name }])) touched.push(...store.albumAssets(album));
        break;
      case "AlbumDeleteV1":
        touched.push(...store.removeAlbums(account, [event.data.albumId]));
        break;
      case "AlbumToAssetV1":
      case "AlbumToAssetBackfillV1":
        store.addToAlbums(account, [{ album: event.data.albumId, asset: event.data.assetId }]);
        break;
      case "AlbumToAssetDeleteV1":
        store.removeFromAlbums(account, [{ album: event.data.albumId, asset: event.data.assetId }]);
        break;
    }
  }
  flushFaces();
  return touched;
}
