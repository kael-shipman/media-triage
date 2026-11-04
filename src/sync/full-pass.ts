// The full pass (DESIGN.md, sections 3 and 13), at start and then daily: it finds every media file in the covered
// folders, stats each one's sidecar, and returns the units whose sidecar changed since the state's record, or that
// have no record yet. It reads no sidecar: the reconcile does, for the units returned.

import fastGlob from "fast-glob";
import { join } from "node:path";
import { sameStamp, stampOf } from "../sidecars/sidecar.ts";
import { unitOf } from "./covered.ts";
import type { SyncStore } from "./store.ts";

export interface FullPass {
  /** Media files found. */
  media: number;
  /** The units to reconcile. */
  changed: string[];
}

export async function fullPass(store: SyncStore, folders: readonly string[]): Promise<FullPass> {
  let media = 0;
  const changed: string[] = [];
  for (const folder of folders) {
    // Hidden files and folders are left out, as Immich's libraries leave them out.
    const files = await fastGlob("**/*", { cwd: folder, onlyFiles: true, dot: false, followSymbolicLinks: false, suppressErrors: true });
    for (const file of files.sort()) {
      const path = join(folder, file);
      if (unitOf(path) !== path) continue;
      media++;
      const record = store.unit(path);
      const sidecar = stampOf(`${path}.xmp`);
      const same = record !== undefined && (record.sidecar === undefined ? sidecar === undefined : sameStamp(record.sidecar, sidecar));
      if (!same) changed.push(path);
    }
  }
  return { media, changed };
}
