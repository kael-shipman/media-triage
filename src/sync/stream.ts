// One account's sync stream, consumed (DESIGN.md, sections 3 and 13): each batch's assets are recorded with their
// paths, the units they belong to are handed to `act` (the reconcile), and only then is the batch acknowledged, so a
// change is never acknowledged before it's acted on. A restart resumes where the last acknowledgement left off.

import { type Asset, getAsset, libraryPages, searchPages } from "../immich/assets.ts";
import { acknowledge, type SyncEvent, syncStream } from "../immich/sync.ts";
import type { PathMap } from "../core/path-map.ts";
import { log } from "../log.ts";
import type { OpenAccount } from "../upkeep/accounts.ts";
import type { AssetRecord, SyncStore } from "./store.ts";

/** Past this many unknown assets in a batch, their libraries are listed whole rather than each asset read alone. */
export const BULK_LOOKUP = 50;

export interface StreamOptions {
  /** Called with each batch's changed units (local media paths), before the batch is acknowledged. */
  act: (units: string[]) => Promise<void>;
  batchSize?: number;
  bulkLookup?: number;
  signal?: AbortSignal;
}

export interface StreamOutcome {
  batches: number;
  events: number;
  /** The server asked for a reset: the account's assets were forgotten, and its stream must be read again. */
  reset: boolean;
}

/** The asset events that can change what a unit should say. Albums, people and faces are milestone 7's. */
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
        store.putAssets(page.map((asset) => record(account, map, asset)));
        for (const asset of page) wanted.delete(asset.id);
      }
    }
  }
  const found: AssetRecord[] = [];
  for (const id of wanted) {
    const asset = await getAsset(account.client, id);
    if (asset) found.push(record(account, map, asset));
  }
  store.putAssets(found);
}

/** Learns every asset of the account, a page at a time: after a reset, or on a first run. */
export async function learnAllAssets(account: OpenAccount, store: SyncStore, map: PathMap): Promise<number> {
  let count = 0;
  for await (const page of searchPages(account.client, {})) {
    store.putAssets(page.map((asset) => record(account, map, asset)));
    count += page.length;
  }
  return count;
}

/** Reads the account's stream to its end, acting on and acknowledging each batch. */
export async function consumeStream(account: OpenAccount, store: SyncStore, map: PathMap, options: StreamOptions): Promise<StreamOutcome> {
  const outcome: StreamOutcome = { batches: 0, events: 0, reset: false };
  for await (const batch of syncStream(account.client, { batchSize: options.batchSize, signal: options.signal })) {
    if (batch.reset) {
      // Acknowledging the reset clears the session's checkpoints; the next read sends everything.
      await acknowledge(account.client, batch.acks);
      store.forgetAccount(account.account.name);
      log.warn("Immich reset the account's sync stream; reading the whole account again", { account: account.account.name });
      outcome.reset = true;
      return outcome;
    }
    outcome.batches++;
    outcome.events += batch.events.length;

    // Record what the stream says about assets, and learn the paths of new ones.
    const unknown = new Map<string, string | null>();
    const changes: { id: string; trashed: boolean; visibility: string }[] = [];
    const deleted: string[] = [];
    for (const event of batch.events) {
      if (event.type === "AssetDeleteV1") deleted.push(event.data.assetId);
      if (event.type !== "AssetV2") continue;
      changes.push({ id: event.data.id, trashed: event.data.deletedAt !== null, visibility: event.data.visibility });
      if (!store.asset(event.data.id)) unknown.set(event.data.id, event.data.libraryId);
    }
    const ids = [...new Set(batch.events.flatMap((event) => assetOf(event) ?? []))];
    for (const id of store.unknownAssets(ids)) if (!unknown.has(id)) unknown.set(id, null);
    await learnAssets(account, store, map, [...unknown].map(([id, library]) => ({ id, library })), options.bulkLookup);
    store.updateAssets(changes);

    // The units those assets belong to, here. Deleted assets' units are acted on too: their copy is gone.
    const units = new Set<string>();
    for (const id of [...ids, ...deleted]) {
      const local = store.asset(id)?.local;
      if (local) units.add(local);
    }
    store.removeAssets(deleted);
    await options.act([...units].sort());
    await acknowledge(account.client, batch.acks);
  }
  return outcome;
}
