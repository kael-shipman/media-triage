// `media-triage rename-tag FROM TO` (DESIGN.md, section 10): renames a tag, and the tags under it, in the sidecars of
// the units the state knows that have it, in Immich's notation. It writes each sidecar as Darktable would, so the
// running daemon carries the change to every Immich copy, as for any edit made in Darktable.

import { CREATOR, TITLE } from "../core/titles.ts";
import { darktableReads } from "../core/xmp.ts";
import type { Exiftool } from "../sidecars/exiftool.ts";
import { readSidecar, writeSidecar } from "../sidecars/sidecar.ts";
import type { SyncStore } from "./store.ts";

export interface RenameReport {
  /** Sidecars changed (or, in a dry run, that would be). */
  renamed: string[];
  /** Sidecars that changed while being written: run it again for them. */
  changedMeanwhile: string[];
}

/** Why a rename can't be done, or undefined if it can. */
export function renameProblem(from: string, to: string): string | undefined {
  for (const tag of [from, to]) {
    if (tag.trim() === "" || tag !== tag.trim()) return `"${tag}" is empty, or starts or ends with a space`;
    if (tag.startsWith("/") || tag.endsWith("/") || tag.includes("//")) return `"${tag}" has an empty part`;
    if (TITLE.is(tag) || CREATOR.is(tag) || tag === TITLE.parent || tag === CREATOR.parent) return `"${tag}" is a title's or a creator's tag: change the title or the creator instead`;
  }
  if (from === to) return "the names are the same";
  if (to.startsWith(`${from}/`)) return `"${to}" is under "${from}"`;
  return undefined;
}

/** A tag renamed: `from` itself, or a tag under it, keeping the rest. */
export function renamed(tag: string, from: string, to: string): string {
  if (tag === from) return to;
  return tag.startsWith(`${from}/`) ? `${to}${tag.slice(from.length)}` : tag;
}

export async function renameTag(store: SyncStore, exiftool: Exiftool, from: string, to: string, options: { dryRun: boolean }): Promise<RenameReport> {
  const report: RenameReport = { renamed: [], changedMeanwhile: [] };
  for (const unit of store.unitsWithTagOrUnder(from)) {
    const sidecar = await readSidecar(exiftool, `${unit}.xmp`);
    if (!sidecar) continue;
    const before = darktableReads(sidecar.fields).tags;
    const tags = [...new Set(before.map((tag) => renamed(tag, from, to)))];
    if (tags.join("\n") === before.join("\n")) continue;
    const outcome = await writeSidecar(exiftool, sidecar, { tags }, { dryRun: options.dryRun });
    if (outcome.status === "changed-meanwhile") report.changedMeanwhile.push(unit);
    else report.renamed.push(unit);
  }
  return report;
}
