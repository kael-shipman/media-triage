// What sync covers (DESIGN.md, sections 1 and 13): the covered folders, the media files in them, and each one's
// sidecar. The watcher and the full pass both start here.

import { readFileSync } from "node:fs";
import { basename, extname, join, normalize } from "node:path";
import type { Config } from "../config.ts";
import { IMMICH_EXTENSIONS } from "../core/media.ts";
import { isConflictCopy, isSidecar } from "../core/orphans.ts";
import { PathMap } from "../core/path-map.ts";

export interface Covered {
  /** Local folders, none inside another. */
  folders: string[];
  /** Library folders the path map doesn't cover (Immich's paths): nothing there is synced. */
  unmapped: string[];
}

/** Every configured library's folders, mapped to local paths, plus the inbox's sources. */
export function coveredFolders(config: Config): Covered {
  const map = new PathMap(config.immich.pathMap);
  const folders = new Set<string>();
  const unmapped: string[] = [];
  for (const library of config.immich.libraries) {
    for (const folder of library.folders) {
      const local = map.toLocal(folder);
      if (local === undefined) unmapped.push(folder);
      else folders.add(trim(local));
    }
  }
  if (config.paths.inbox) for (const source of config.sources) folders.add(trim(join(config.paths.inbox, source.folder)));
  const sorted = [...folders].sort();
  return { folders: sorted.filter((folder) => !sorted.some((other) => other !== folder && folder.startsWith(`${other}/`))), unmapped: [...new Set(unmapped)].sort() };
}

const trim = (path: string) => normalize(path).replace(/\/+$/, "");

const MEDIA = new Set(IMMICH_EXTENSIONS);

/** Whether Immich indexes this file name (by extension, ignoring case). */
export function isMedia(name: string): boolean {
  return MEDIA.has(extname(name).toLowerCase());
}

/**
 * The unit a changed path belongs to: the media file itself, or the one a `<file>.<ext>.xmp` sidecar belongs to.
 * Undefined for what sync leaves alone: hidden files (including temporary ones, the daemon's and Syncthing's),
 * exiftool's temporary files, Syncthing's conflict copies, other files, and sidecars named any other way (Darktable
 * reads only `<file>.<ext>.xmp`, so a `<stem>.xmp` or a duplicate's `<stem>_01.<ext>.xmp` isn't synced).
 */
export function unitOf(path: string): string | undefined {
  const name = basename(path);
  if (name.startsWith(".") || name.includes("_exiftool_tmp") || isConflictCopy(name)) return undefined;
  if (isSidecar(name)) {
    const media = path.slice(0, -".xmp".length);
    return isMedia(media) && !/_\d{2,}\.[^.]+$/.test(basename(media)) ? media : undefined;
  }
  return isMedia(name) ? path : undefined;
}

/** The kernel's allowance of inotify watches per user, or undefined if it can't be read. */
export function watchAllowance(): number | undefined {
  try {
    return Number(readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8").trim()) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A warning when the covered folders need more than half the allowance of inotify watches (one per folder), since
 * other programs, such as Syncthing, take theirs from the same allowance. Undefined when there's room.
 */
export function watchWarning(folders: number, allowance: number | undefined): string | undefined {
  if (allowance === undefined || folders * 2 <= allowance) return undefined;
  const enough = 2 ** Math.ceil(Math.log2(folders * 4));
  return (
    `The covered folders hold ${folders} folders, each needing an inotify watch, and the allowance is ${allowance} ` +
    `(shared with other programs, such as Syncthing). Changes may go unseen until the daily full pass. Raise it: ` +
    `\`echo fs.inotify.max_user_watches=${enough} | sudo tee /etc/sysctl.d/90-media-triage.conf && sudo sysctl --system\`.`
  );
}
