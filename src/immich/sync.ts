// Immich's sync stream (`POST /api/sync/stream`), the feed of changes its phone apps use (DESIGN.md, section 3).
//
// The SDK's `getSyncStream` reads the whole response as text, and on a first run that's every asset in the account.
// So the stream is read here with fetch, line by line as it arrives, and handed on in batches (DESIGN.md, section 13).

import {
  type SyncAckV1,
  type SyncAlbumDeleteV1,
  type SyncAlbumToAssetDeleteV1,
  type SyncAlbumToAssetV1,
  type SyncAlbumV2,
  type SyncAssetDeleteV1,
  type SyncAssetExifV1,
  type SyncAssetFaceDeleteV1,
  type SyncAssetFaceV3,
  type SyncAssetV2,
  type SyncCompleteV1,
  type SyncPersonDeleteV1,
  type SyncPersonV1,
  SyncRequestType,
  type SyncResetV1,
  deleteSyncAck,
  getSyncAck,
  sendSyncAck,
} from "@immich/sdk";
import { log } from "../log.ts";
import { type ImmichClient, ImmichError, toImmichError } from "./client.ts";

/** The types the daemon follows. Immich 3.3 refuses `AssetsV1`, and `AlbumsV2` is the current albums type. */
export const SYNC_TYPES: readonly SyncRequestType[] = [
  SyncRequestType.AssetsV2,
  SyncRequestType.AssetExifsV1,
  SyncRequestType.AlbumsV2,
  SyncRequestType.AlbumToAssetsV1,
  SyncRequestType.PeopleV1,
  SyncRequestType.AssetFacesV3,
];

/** The lines `SYNC_TYPES` bring, by their `type`, with what each one's `data` holds. */
interface SyncData {
  AssetV2: SyncAssetV2;
  AssetDeleteV1: SyncAssetDeleteV1;
  AssetExifV1: SyncAssetExifV1;
  AlbumV2: SyncAlbumV2;
  AlbumDeleteV1: SyncAlbumDeleteV1;
  AlbumToAssetV1: SyncAlbumToAssetV1;
  /** An album's assets, sent when the account gains access to an album that already had them. */
  AlbumToAssetBackfillV1: SyncAlbumToAssetV1;
  AlbumToAssetDeleteV1: SyncAlbumToAssetDeleteV1;
  PersonV1: SyncPersonV1;
  PersonDeleteV1: SyncPersonDeleteV1;
  /** Every face on every asset in the account's cluster group, not only the account's own. */
  AssetFaceV3: SyncAssetFaceV3;
  AssetFaceDeleteV1: SyncAssetFaceDeleteV1;
  /** Only an acknowledgement: a backfill finished. */
  SyncAckV1: SyncAckV1;
  /** Instead of changes: the session's checkpoints must be cleared, and everything read again. */
  SyncResetV1: SyncResetV1;
  /** The end of a stream. */
  SyncCompleteV1: SyncCompleteV1;
}

export type SyncEventType = keyof SyncData;

/** One line of the stream. `ack` is `<type>|<id>`, acknowledged once the change has been acted on. */
export type SyncEvent = { [T in SyncEventType]: { type: T; data: SyncData[T]; ack: string } }[SyncEventType];

const KNOWN_TYPES = new Set<string>([
  "AssetV2",
  "AssetDeleteV1",
  "AssetExifV1",
  "AlbumV2",
  "AlbumDeleteV1",
  "AlbumToAssetV1",
  "AlbumToAssetBackfillV1",
  "AlbumToAssetDeleteV1",
  "PersonV1",
  "PersonDeleteV1",
  "AssetFaceV3",
  "AssetFaceDeleteV1",
  "SyncAckV1",
  "SyncResetV1",
  "SyncCompleteV1",
] satisfies SyncEventType[]);

export interface SyncBatch {
  /** The changes, in the order the server sent them, without the bookkeeping lines (`SyncAckV1`, `SyncCompleteV1`). */
  events: SyncEvent[];
  /** What to acknowledge once the events are acted on: the last ack of each type in the batch. */
  acks: string[];
  /** The server asked for a reset (`SyncResetV1`), and sent nothing else. */
  reset: boolean;
  /** This is the stream's last batch, ending with `SyncCompleteV1`. */
  complete: boolean;
}

/**
 * Splits a stream of bytes into JSON values, one per line, as they arrive. Only the current line is ever held in
 * memory, besides the chunk being read.
 */
export async function* jsonLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n", start)) {
      const line = buffered.slice(start, newline);
      start = newline + 1;
      if (line.trim() !== "") yield JSON.parse(line);
    }
    buffered = buffered.slice(start);
  }
  buffered += decoder.decode();
  if (buffered.trim() !== "") yield JSON.parse(buffered);
}

/** The type of an ack, `<type>|<id>[|<extra>]`. */
function ackType(ack: string): string {
  const bar = ack.indexOf("|");
  return bar < 0 ? ack : ack.slice(0, bar);
}

/** The last ack of each type, in the order the types first appeared. The server keeps one checkpoint per type. */
export function lastAckPerType(acks: Iterable<string>): string[] {
  const byType = new Map<string, string>();
  for (const ack of acks) byType.set(ackType(ack), ack);
  return [...byType.values()];
}

/**
 * Groups the stream's lines into batches of at most `size` changes. Lines of types the daemon doesn't know are left
 * out, but still acknowledged, so they aren't sent again.
 */
export async function* batchEvents(lines: AsyncIterable<unknown>, size: number): AsyncGenerator<SyncBatch> {
  let events: SyncEvent[] = [];
  let acks: string[] = [];
  const flush = (extra: Partial<SyncBatch> = {}): SyncBatch => {
    const batch = { events, acks: lastAckPerType(acks), reset: false, complete: false, ...extra };
    events = [];
    acks = [];
    return batch;
  };

  for await (const line of lines) {
    const { type, ack } = line as { type?: unknown; ack?: unknown };
    if (typeof type !== "string" || typeof ack !== "string") {
      throw new ImmichError(`Reading the sync stream: a line without a type or an ack: ${JSON.stringify(line).slice(0, 200)}`, 0);
    }
    acks.push(ack);
    if (type === "SyncResetV1") {
      yield flush({ events: [], acks: [ack], reset: true });
      return;
    }
    if (type === "SyncCompleteV1") {
      yield flush({ complete: true });
      return;
    }
    if (type === "SyncAckV1") continue;
    if (!KNOWN_TYPES.has(type)) {
      log.debug("sync stream: skipping a type this version doesn't handle", { type });
      continue;
    }
    events.push(line as SyncEvent);
    if (events.length >= size) yield flush();
  }
  // The stream ended without SyncCompleteV1: the connection dropped. What arrived can still be acted on and
  // acknowledged; the next stream starts from there.
  if (events.length > 0 || acks.length > 0) yield flush();
}

export interface StreamOptions {
  /** The types to ask for (default: `SYNC_TYPES`). */
  types?: readonly SyncRequestType[];
  /** The most changes in one batch (default 1,000). */
  batchSize?: number;
  signal?: AbortSignal;
}

/**
 * Reads an account's changes since its last acknowledgements, in batches. Act on each batch, then acknowledge it
 * with `acknowledge`. A batch with `reset` must be acknowledged too, which clears the session's checkpoints; the next
 * stream then sends everything.
 */
export async function* syncStream(client: ImmichClient, options: StreamOptions = {}): AsyncGenerator<SyncBatch> {
  const what = "Reading the sync stream";
  let response: Response;
  try {
    response = await fetch(`${client.apiUrl}/sync/stream`, {
      method: "POST",
      headers: { ...client.headers(), "content-type": "application/json", accept: "application/jsonlines+json" },
      body: JSON.stringify({ types: options.types ?? SYNC_TYPES }),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw toImmichError(error, what, client.url);
  }
  if (!response.ok || !response.body) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // not JSON
    }
    throw new ImmichError(`${what}: Immich answered ${response.status}: ${message}`, response.status);
  }
  try {
    yield* batchEvents(jsonLines(response.body), options.batchSize ?? 1000);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ImmichError(`${what}: a line isn't JSON: ${error.message}`, 0);
    if ((error as Error).name === "AbortError") throw error;
    throw toImmichError(error, what, client.url);
  }
}

/** Acknowledges changes once they've been acted on (`POST /api/sync/ack`). */
export async function acknowledge(client: ImmichClient, acks: readonly string[]): Promise<void> {
  if (acks.length === 0) return;
  await client.call("Acknowledging sync changes", (opts) => sendSyncAck({ syncAckSetDto: { acks: [...acks] } }, opts));
}

/** The session's checkpoints, one ack per type (`GET /api/sync/ack`). */
export async function checkpoints(client: ImmichClient): Promise<string[]> {
  const acks = await client.call("Reading the sync checkpoints", (opts) => getSyncAck(opts));
  return acks.map((ack) => ack.ack);
}

/** Forgets every checkpoint, so the next stream sends everything again (`DELETE /api/sync/ack`). */
export async function forgetCheckpoints(client: ImmichClient): Promise<void> {
  await client.call("Clearing the sync checkpoints", (opts) => deleteSyncAck({ syncAckDeleteDto: {} }, opts));
}
