// Reading and writing sidecars (DESIGN.md, sections 5, 6 and 9).
//
// - A write changes only the fields that have to change (src/core/xmp.ts, `planWrite`).
// - Just before writing, the file is checked again: if it changed since it was read (Darktable or Immich wrote it),
//   nothing is written, and the unit waits for the next pass (section 5, step 3).
// - After writing, the file's new stamp is returned, for the state to record, so the daemon recognizes its own writes
//   and the full pass can skip the file until it changes again (section 13).

import { linkSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sidecarName } from "../core/naming.ts";
import { type Assignments, type Wanted, type XmpFields, planWrite } from "../core/xmp.ts";
import type { Exiftool } from "./exiftool.ts";

/** What tells one version of a file from the next. exiftool replaces a file it writes, so its inode changes too. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
  ino: number;
}

export interface Sidecar {
  path: string;
  /** The file as it was read. */
  stamp: FileStamp;
  fields: XmpFields;
}

/** A file's stamp, or undefined if there's no file. */
export function stampOf(path: string): FileStamp | undefined {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat && { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

export function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  return a !== undefined && b !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/**
 * Reads a sidecar, or returns undefined if there's none. If the file changes while it's read, it's read again, a few
 * times at most; the stamp is always the one from before the read, so a write never goes ahead on a stale read.
 */
export async function readSidecar(exiftool: Exiftool, path: string): Promise<Sidecar | undefined> {
  for (let attempt = 1; ; attempt++) {
    const stamp = stampOf(path);
    if (!stamp) return undefined;
    const fields = await exiftool.read(path);
    if (sameStamp(stamp, stampOf(path)) || attempt === 3) return { path, stamp, fields };
  }
}

export type WriteOutcome =
  /** Everything already says what's wanted. */
  | { status: "unchanged" }
  /** A dry run: what would be written. */
  | { status: "dry-run"; plan: Assignments }
  /** The file changed since it was read, so nothing was written. Read it again and merge again. */
  | { status: "changed-meanwhile"; plan: Assignments }
  | { status: "written"; plan: Assignments; stamp: FileStamp };

/** Writes what's wanted to a sidecar, if anything has to change and the file is still as it was read. */
export async function writeSidecar(exiftool: Exiftool, sidecar: Sidecar, wanted: Wanted, options: { dryRun?: boolean } = {}): Promise<WriteOutcome> {
  const plan = planWrite(sidecar.fields, wanted);
  if (Object.keys(plan).length === 0) return { status: "unchanged" };
  if (options.dryRun) return { status: "dry-run", plan };
  if (!sameStamp(stampOf(sidecar.path), sidecar.stamp)) return { status: "changed-meanwhile", plan };
  await exiftool.write(sidecar.path, plan);
  const stamp = stampOf(sidecar.path);
  if (!stamp) throw new Error(`${sidecar.path} disappeared just after it was written`);
  return { status: "written", plan, stamp };
}

export type CreateOutcome = { status: "exists" } | { status: "dry-run"; path: string } | { status: "created"; sidecar: Sidecar };

/**
 * A minimal sidecar for a media file that has none: `<file>.<ext>.xmp`, the name Darktable and Immich both look for
 * first, with only `dc:creator` (F2). It never replaces a sidecar: it's written under a temporary name and linked into
 * place, which fails if one appeared in the meantime.
 */
export async function createSidecar(exiftool: Exiftool, mediaPath: string, creator: string, options: { dryRun?: boolean } = {}): Promise<CreateOutcome> {
  const path = sidecarName(mediaPath);
  if (stampOf(path)) return { status: "exists" };
  if (options.dryRun) return { status: "dry-run", path };
  // Hidden, so Immich (and the daemon's own crawl) skip it, and ending in .xmp, so exiftool creates an XMP file.
  const temporary = join(dirname(path), `.${basename(mediaPath)}.media-triage-${process.pid}-${crypto.randomUUID().slice(0, 8)}.xmp`);
  try {
    await exiftool.write(temporary, { "XMP-dc:Creator": [creator] });
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "exists" };
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  const sidecar = await readSidecar(exiftool, path);
  if (!sidecar) throw new Error(`${path} disappeared just after it was created`);
  return { status: "created", sidecar };
}
