// Where filing puts a ready unit (DESIGN.md, section 7): the moves for its media file, its sidecar, and a Live Photo's
// video with its sidecar, named as the author's Darktable "Archive RAW" export preset names files, with one collision
// number for the whole unit. Planned for a whole batch before anything moves, so names in the batch don't collide.
// What's on disk is only looked at, through `Disk`, so the plan can be tested without files.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Config } from "../config.ts";
import { isVideo } from "../core/media.ts";
import { fileName, filingName, freeCollision, parseWallTime, sidecarName } from "../core/naming.ts";
import { dateFromImmich } from "../core/xmp.ts";

export interface Move {
  from: string;
  to: string;
}

export interface UnitPlan {
  unit: string;
  /** The media file's new path: the unit's, once filed. */
  destination: string;
  /** The media file first, then its sidecar, then a Live Photo's video and its sidecar. */
  moves: Move[];
}

export type PlanResult = { plan: UnitPlan } | { problem: string };

/** What the plan looks at on disk. */
export interface Disk {
  exists(path: string): boolean;
  /** The names in a folder, or none if it doesn't exist. */
  list(folder: string): string[];
  /** The filesystem a path is on: its own, or its nearest existing parent's. */
  device(path: string): number;
}

export const disk: Disk = {
  exists: (path) => existsSync(path),
  list: (folder) => (existsSync(folder) ? readdirSync(folder) : []),
  device(path) {
    for (let at = path; ; at = dirname(at)) {
      const stat = statSync(at, { throwIfNoEntry: false });
      if (stat) return stat.dev;
      if (dirname(at) === at) return -1;
    }
  },
};

export interface PlanInput {
  unit: string;
  title: string;
  creator: string | null;
  /** The capture time as the merge has it, or null. */
  date: string | null;
  /** A copy's dates, for when the sidecar has none: Immich's own (its `localDateTime`), as for a video. */
  immich?: { localDateTime: string; fileCreatedAt: string; timeZone?: string | null };
  /** A Live Photo's video, here, if the unit has one. */
  liveVideo?: string;
}

const extension = (path: string) => extname(path).slice(1);
const stemOf = (name: string) => name.slice(0, name.length - extname(name).length);

/** Darktable duplicates' sidecars of a media file: `<stem>_01.<ext>.xmp`, and so on. */
function duplicates(unit: string, names: readonly string[]): string[] {
  const name = basename(unit);
  const pattern = new RegExp(`^${RegExp.escape(stemOf(name))}_\\d{2,}${RegExp.escape(extname(name))}\\.xmp$`, "i");
  return names.filter((candidate) => pattern.test(candidate));
}

/**
 * Plans one unit. `taken` holds the paths the batch's earlier units will take, and gets this unit's. A problem is a
 * reason the unit can't be filed: it stays where it is, and is reported.
 */
export function planUnit(config: Config, input: PlanInput, taken: Set<string>, on: Disk = disk): PlanResult {
  if (!config.paths.archive) return { problem: "no archive is configured (paths.archive)" };
  const time = parseWallTime(input.date ?? "") ?? (input.immich ? parseWallTime(dateFromImmich(input.immich)) : undefined);
  if (!time) return { problem: "it has no capture time" };

  const siblings = on.list(dirname(input.unit));
  if (duplicates(input.unit, siblings).length > 0) return { problem: "it has Darktable duplicates, which filing doesn't move" };

  const root = isVideo(input.unit) ? config.filing.videos : config.filing.photos;
  const name = filingName({ root, time, title: input.title, creator: input.creator ?? undefined });
  const folder = join(config.paths.archive, name.folder);
  if (on.device(folder) !== on.device(input.unit)) return { problem: `the archive is on another filesystem than ${dirname(input.unit)}` };

  const files = [input.unit, ...(input.liveVideo ? [input.liveVideo] : [])];
  const collision = freeCollision(name.stem, files.map(extension), (candidate) => taken.has(join(folder, candidate)) || on.exists(join(folder, candidate)));
  const moves: Move[] = [];
  for (const file of files) {
    const to = join(folder, fileName(name.stem, extension(file), collision));
    moves.push({ from: file, to });
    if (on.exists(sidecarName(file))) moves.push({ from: sidecarName(file), to: sidecarName(to) });
  }
  for (const move of moves) taken.add(move.to);
  return { plan: { unit: input.unit, destination: moves[0]!.to, moves } };
}
