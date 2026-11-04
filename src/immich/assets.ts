// Assets: finding them by library or path, and changing them in bulk (DESIGN.md, sections 3 and 13).
//
// Every call that changes assets takes a list of IDs, and sends at most 1,000 per request. Immich's body limit is
// far higher, but this bounds the work in each request.

import {
  AssetJobName,
  type AssetResponseDto,
  type AssetVisibility,
  type SearchFilter,
  deleteAssets,
  getAssetInfo,
  restoreAssets as sdkRestoreAssets,
  runAssetJobs,
  searchAssets,
  updateAssets,
} from "@immich/sdk";
import { type ImmichClient, ImmichError } from "./client.ts";

export type Asset = AssetResponseDto;

/** IDs per request. */
export const IDS_PER_REQUEST = 1000;
/** Paths per search. Paths are longer than IDs, and each one is a term in the query. */
export const PATHS_PER_SEARCH = 500;
/** Results per page of a search: Immich's maximum. */
export const PAGE_SIZE = 1000;

/** Splits a list into consecutive pieces of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const pieces: T[][] = [];
  for (let start = 0; start < items.length; start += size) pieces.push(items.slice(start, start + size));
  return pieces;
}

/**
 * Every asset matching a search filter, a page at a time (`POST /api/search/metadata`, its structured form).
 *
 * The search covers the account's own assets (and partners', if it has any), trashed, archived, hidden (a Live
 * Photo's video) and offline ones included. It leaves out locked assets, unless the session was unlocked with the
 * account's PIN. Pages are in a stable order (Immich breaks ties by ID).
 */
export async function* searchPages(
  client: ImmichClient,
  filter: SearchFilter,
  options: { withExif?: boolean; pageSize?: number } = {},
): AsyncGenerator<Asset[]> {
  let cursor: string | undefined;
  do {
    const { assets } = await client.call("Searching assets", (opts) =>
      searchAssets({ metadataSearchDto: { filter, size: options.pageSize ?? PAGE_SIZE, cursor, withExif: options.withExif } }, opts),
    );
    if (assets.items.length > 0) yield assets.items;
    cursor = assets.nextCursor ?? undefined;
  } while (cursor);
}

/** Every asset in a library, a page at a time. For learning many assets' paths at once. */
export function libraryPages(client: ImmichClient, libraryId: string, options: { pageSize?: number } = {}): AsyncGenerator<Asset[]> {
  return searchPages(client, { libraryId: { eq: libraryId } }, options);
}

/**
 * The assets at these paths (Immich's), in as few searches as it takes. A path can have several assets: one per
 * library that indexes it, and partners' if the account has any. Check `ownerId` and `libraryId`.
 */
export async function findByPaths(client: ImmichClient, paths: readonly string[]): Promise<Asset[]> {
  const found: Asset[] = [];
  for (const piece of chunks([...new Set(paths)], PATHS_PER_SEARCH)) {
    for await (const page of searchPages(client, { originalPath: { in: piece } })) found.push(...page);
  }
  return found;
}

/**
 * One asset, with its tags, faces' people and EXIF (`GET /api/assets/{id}`), or undefined if Immich won't show it.
 * That's an asset that's gone, but also a locked one, unless the session was unlocked with the PIN: Immich gives the
 * same answer for both. So undefined doesn't mean deleted; the sync stream says which assets are locked.
 */
export async function getAsset(client: ImmichClient, id: string): Promise<Asset | undefined> {
  try {
    return await client.call(`Reading asset ${id}`, (opts) => getAssetInfo({ id }, opts));
  } catch (error) {
    // Immich answers 400 "Not found or no asset.read access" for an asset that doesn't exist.
    if (error instanceof ImmichError && error.status === 400 && error.message.includes("Not found")) return undefined;
    throw error;
  }
}

/** Has Immich read the sidecars of these assets again (`POST /api/assets/jobs`, `refresh-metadata`). F1. */
export async function refreshMetadata(client: ImmichClient, ids: readonly string[]): Promise<void> {
  for (const piece of chunks(ids, IDS_PER_REQUEST)) {
    await client.call("Refreshing metadata", (opts) => runAssetJobs({ assetJobsDto: { assetIds: piece, name: AssetJobName.RefreshMetadata } }, opts));
  }
}

/** Moves assets to the trash (`DELETE /api/assets`, never `force`): their files stay until the trash is emptied. F8. */
export async function trashAssets(client: ImmichClient, ids: readonly string[]): Promise<void> {
  for (const piece of chunks(ids, IDS_PER_REQUEST)) {
    await client.call("Trashing assets", (opts) => deleteAssets({ assetBulkDeleteDto: { ids: piece, force: false } }, opts));
  }
}

/** Takes assets out of the trash (`POST /api/trash/restore/assets`). F8. */
export async function restoreAssets(client: ImmichClient, ids: readonly string[]): Promise<void> {
  for (const piece of chunks(ids, IDS_PER_REQUEST)) {
    await client.call("Restoring assets", (opts) => sdkRestoreAssets({ bulkIdsDto: { ids: piece } }, opts));
  }
}

/** Sets or clears assets' favorite (`PUT /api/assets`). Filing puts it back (F9). */
export async function setFavorite(client: ImmichClient, ids: readonly string[], isFavorite: boolean): Promise<void> {
  for (const piece of chunks(ids, IDS_PER_REQUEST)) {
    await client.call("Setting favorites", (opts) => updateAssets({ assetBulkUpdateDto: { ids: piece, isFavorite } }, opts));
  }
}

/** Sets assets' visibility: archived, in the timeline, or locked (`PUT /api/assets`). Filing puts it back (F9). */
export async function setVisibility(client: ImmichClient, ids: readonly string[], visibility: AssetVisibility): Promise<void> {
  for (const piece of chunks(ids, IDS_PER_REQUEST)) {
    await client.call("Setting visibility", (opts) => updateAssets({ assetBulkUpdateDto: { ids: piece, visibility } }, opts));
  }
}
