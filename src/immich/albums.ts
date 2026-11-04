// Albums: an account's own, which filing puts new copies back into (DESIGN.md, F9 and section 7).

import { type AlbumResponseDto, BulkIdErrorReason, addAssetsToAlbum, createAlbum as sdkCreateAlbum, getAllAlbums, removeAssetFromAlbum } from "@immich/sdk";
import { IDS_PER_REQUEST, chunks } from "./assets.ts";
import { type BulkFailure, failures } from "./bulk.ts";
import type { ImmichClient } from "./client.ts";

export type Album = AlbumResponseDto;

/** The albums the account owns or was given, or only those holding `assetId` (`GET /api/albums`). */
export function listAlbums(client: ImmichClient, options: { assetId?: string } = {}): Promise<Album[]> {
  return client.call("Listing albums", (opts) => getAllAlbums({ assetId: options.assetId }, opts));
}

export function createAlbum(client: ImmichClient, name: string, assetIds: readonly string[] = []): Promise<Album> {
  return client.call(`Creating album "${name}"`, (opts) => sdkCreateAlbum({ createAlbumDto: { albumName: name, assetIds: [...assetIds] } }, opts));
}

/** Adds assets to an album. Assets already in it are fine. Returns the ones that failed. */
export async function addToAlbum(client: ImmichClient, albumId: string, ids: readonly string[]): Promise<BulkFailure[]> {
  const failed: BulkFailure[] = [];
  for (const piece of chunks(ids, IDS_PER_REQUEST)) {
    const results = await client.call("Adding assets to an album", (opts) => addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids: piece } }, opts));
    failed.push(...failures(results, [BulkIdErrorReason.Duplicate]));
  }
  return failed;
}

/** Takes assets out of an album. Assets that weren't in it are fine. Returns the ones that failed. */
export async function removeFromAlbum(client: ImmichClient, albumId: string, ids: readonly string[]): Promise<BulkFailure[]> {
  const failed: BulkFailure[] = [];
  for (const piece of chunks(ids, IDS_PER_REQUEST)) {
    const results = await client.call("Removing assets from an album", (opts) => removeAssetFromAlbum({ id: albumId, bulkIdsDto: { ids: piece } }, opts));
    failed.push(...failures(results, [BulkIdErrorReason.NotFound]));
  }
  return failed;
}
