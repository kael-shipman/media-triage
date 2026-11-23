// The full pass (DESIGN.md, sections 3 and 13), at start and then daily: it finds every media file in the covered
// folders, stats each one's sidecar, and returns the units whose sidecar changed since the state's record, or that
// have no record yet, or whose media file was gone and is back, or whose record has `Inbox` where it shouldn't, or
// lacks it where it should (so units already recorded get the tag, and lose it if moved by hand), or whose record has a
// creator that wasn't yet its tag (so units recorded before 0.4.0 get `Creator/<creator>`, F3), or, with F12 on, whose
// record has a hand-made `People/…` tag and wasn't looked at under F12 (so the archive's are). It reads no sidecar:
// the reconcile does, for the units returned. It also returns the sidecars that belong to no media file (F11), and
// Syncthing's conflict copies of sidecars, for `handleOrphans`.

import fastGlob from "fast-glob";
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { INBOX_TAG } from "../core/naming.ts";
import { isConflictCopy, isSidecar, sidecarOwner } from "../core/orphans.ts";
import { sameStamp, stampOf } from "../sidecars/sidecar.ts";
import { unitOf } from "./covered.ts";
import { personNameOf } from "../core/people-from-tags.ts";
import type { SyncStore, SyncedValues } from "./store.ts";

export interface FullPass {
  /** Media files found. */
  media: number;
  /** The units to reconcile. */
  changed: string[];
  /** Sidecars whose media file isn't in their folder. */
  orphans: string[];
  /** Syncthing's conflict copies of sidecars, which need a person. */
  conflicts: string[];
}

/** Whether a record has a hand-made `People/…` tag (F12): one the daemon didn't make from a face (F10). */
function hasHandPeopleTag(synced: SyncedValues): boolean {
  const made = new Set(synced.people ?? []);
  return synced.tags.some((tag) => personNameOf(tag) !== undefined && !made.has(tag));
}

/** `inbox` says whether a media file is in an inbox source; `peopleFromTags` is F12's switch. */
export async function fullPass(
  store: SyncStore,
  folders: readonly string[],
  inbox: (path: string) => boolean = () => false,
  options: { peopleFromTags?: boolean } = {},
): Promise<FullPass> {
  const result: FullPass = { media: 0, changed: [], orphans: [], conflicts: [] };
  for (const folder of folders) {
    // Hidden files and folders are left out, as Immich's libraries leave them out. A link to a file counts as a file,
    // as Immich indexes it; linked folders aren't entered, since a library's exclusions aren't applied here.
    const entries = await fastGlob("**/*", { cwd: folder, onlyFiles: false, dot: false, followSymbolicLinks: false, suppressErrors: true, objectMode: true });
    const files = entries
      .filter((entry) => entry.dirent.isFile() || (entry.dirent.isSymbolicLink() && isFile(join(folder, entry.path))))
      .map((entry) => entry.path)
      .sort();
    const names = new Map<string, string[]>();
    for (const file of files) {
      const path = join(folder, file);
      names.set(dirname(path), [...(names.get(dirname(path)) ?? []), basename(path)]);
    }
    for (const file of files) {
      const path = join(folder, file);
      const name = basename(path);
      if (isSidecar(name)) {
        if (isConflictCopy(name)) result.conflicts.push(path);
        else if (!sidecarOwner(name, names.get(dirname(path)) ?? [])) result.orphans.push(path);
        continue;
      }
      if (unitOf(path) !== path) continue;
      result.media++;
      const record = store.unit(path);
      const sidecar = stampOf(`${path}.xmp`);
      const same = record !== undefined && record.gone === undefined && (record.sidecar === undefined ? sidecar === undefined : sameStamp(record.sidecar, sidecar));
      const tagged = record !== undefined && record.synced.tags.includes(INBOX_TAG) === inbox(path);
      const creatorTagged = record === undefined || record.synced.creator === null || record.synced.creatorTag === true;
      const peopleChecked = !options.peopleFromTags || record === undefined || record.synced.peopleChecked === true || !hasHandPeopleTag(record.synced);
      if (!same || !tagged || !creatorTagged || !peopleChecked) result.changed.push(path);
    }
  }
  return result;
}

/** Whether a path leads to a file, following links. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
