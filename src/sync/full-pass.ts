// The full pass (DESIGN.md, sections 3 and 13), at start and then daily: it finds every media file in the covered
// folders, stats each one's sidecar, and returns the units whose sidecar changed since the state's record, or that
// have no record yet, or whose media file was gone and is back. It reads no sidecar: the reconcile does, for the units
// returned. It also returns the sidecars that belong to no media file (F11), and Syncthing's conflict copies of
// sidecars, for `handleOrphans`.

import fastGlob from "fast-glob";
import { basename, dirname, join } from "node:path";
import { isConflictCopy, isSidecar, sidecarOwner } from "../core/orphans.ts";
import { sameStamp, stampOf } from "../sidecars/sidecar.ts";
import { unitOf } from "./covered.ts";
import type { SyncStore } from "./store.ts";

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

export async function fullPass(store: SyncStore, folders: readonly string[]): Promise<FullPass> {
  const result: FullPass = { media: 0, changed: [], orphans: [], conflicts: [] };
  for (const folder of folders) {
    // Hidden files and folders are left out, as Immich's libraries leave them out.
    const files = (await fastGlob("**/*", { cwd: folder, onlyFiles: true, dot: false, followSymbolicLinks: false, suppressErrors: true })).sort();
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
      if (!same) result.changed.push(path);
    }
  }
  return result;
}
