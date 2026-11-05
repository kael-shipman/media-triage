// Orphan sidecars (DESIGN.md, F11): a sidecar whose media file is gone is deleted, but only once the daemon has seen
// the media file and seen it go, the grace period earlier. The daemon sees a media file go when the reconcile finds it
// missing (the watcher reports its deletion), or when a full pass finds its sidecar alone. Orphans whose media file
// the daemon never saw, such as a sidecar that arrived before its video, or one whose video a sync tool leaves out on
// this machine, are reported and left alone, and so are Syncthing's conflict copies.

import { readdirSync, unlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { sidecarOwner } from "../core/orphans.ts";
import { log } from "../log.ts";
import { isMedia } from "./covered.ts";
import type { SyncStore, UnitRecord } from "./store.ts";

export interface OrphanOutcome {
  /** Sidecars deleted (in a dry run, that would be). */
  deleted: string[];
  /** Seen, then gone, but not for the grace period yet. */
  waiting: string[];
  /** Orphans whose media file the daemon never saw. */
  unknown: string[];
}

/** The media files a sidecar can belong to: `<file>.<ext>` for `<file>.<ext>.xmp`, and so on (F11). */
export function mediaFor(store: SyncStore, sidecar: string): string[] {
  const media = sidecar.slice(0, -".xmp".length);
  if (!isMedia(media)) return store.unitsWithStem(dirname(sidecar), basename(media));
  const duplicate = /^(.*)_\d{2,}(\.[^.]+)$/.exec(media);
  return duplicate ? [media, duplicate[1]! + duplicate[2]!] : [media];
}

export function handleOrphans(store: SyncStore, orphans: readonly string[], options: { graceMs: number; now: number; dryRun: boolean }): OrphanOutcome {
  const outcome: OrphanOutcome = { deleted: [], waiting: [], unknown: [] };
  // Records are forgotten after every orphan is handled: a media file can have several sidecars (a duplicate's).
  const forget = new Set<string>();
  for (const sidecar of orphans) {
    const records = mediaFor(store, sidecar).flatMap((path) => store.unit(path) ?? []);
    if (records.length === 0) {
      outcome.unknown.push(sidecar);
      continue;
    }
    const gone = records.flatMap((record: UnitRecord) => record.gone ?? []).sort()[0];
    if (gone === undefined) {
      // Seen, and now gone: the grace period starts now.
      if (!options.dryRun) for (const record of records) store.markGone(record.path, new Date(options.now).toISOString());
      outcome.waiting.push(sidecar);
      continue;
    }
    if (options.now - Date.parse(gone) < options.graceMs) {
      outcome.waiting.push(sidecar);
      continue;
    }
    // Look again, just before: the media file may have come back since the pass listed the folder.
    let names: string[];
    try {
      names = readdirSync(dirname(sidecar));
    } catch {
      continue;
    }
    if (!names.includes(basename(sidecar)) || sidecarOwner(basename(sidecar), names)) continue;
    if (!options.dryRun) {
      try {
        unlinkSync(sidecar);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn("couldn't delete an orphan sidecar; it's tried again at the next full pass", { sidecar, error: error as Error });
          continue;
        }
      }
      for (const record of records) forget.add(record.path);
    }
    outcome.deleted.push(sidecar);
  }
  for (const path of forget) store.removeUnit(path);
  return outcome;
}
