// Filing a batch of ready units (DESIGN.md, section 7): plan every unit, record the plans, then for each unit remove
// `Promote` from its sidecar and move its files with `link()` then `unlink()`, never overwriting and never removing a
// file before its new name exists. The unit's sync record moves with it, so what the daemon made (F10) is still known
// at the new path. Then the unit is being put back (src/filing/restore.ts) until its new copies have their state,
// and Immich is asked to scan the libraries holding the old and new paths, since it notices neither until it scans.
//
// A plan cut short is finished on the next run (`finishPlanned`): each move is made again only if it isn't yet.

import { linkSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isVideo } from "../core/media.ts";
import { NEEDS_TITLE_TAG, PROMOTE_TAG } from "../core/naming.ts";
import { PathMap } from "../core/path-map.ts";
import { darktableReads } from "../core/xmp.ts";
import { listLibraries, scanLibrary } from "../immich/libraries.ts";
import { log } from "../log.ts";
import { readSidecar, type Sidecar, sameStamp, stampOf, writeSidecar } from "../sidecars/sidecar.ts";
import type { ReadyUnit, ReconcileContext } from "../sync/reconcile.ts";
import { type Disk, type Move, type UnitPlan, disk, planUnit } from "./plan.ts";
import { FilingStore } from "./store.ts";

export interface FilingReport {
  /** Units moved, from and to. */
  filed: { unit: string; destination: string }[];
  /** Units that can't be filed, and why. They stay where they are. */
  problems: { unit: string; problem: string }[];
}

/** A Live Photo's video, here: Immich's pairing, or else a video beside it with the same name. */
export function liveVideoOf(ctx: ReconcileContext, ready: ReadyUnit, on: Disk = disk): string | undefined {
  for (const { asset } of ready.copies) {
    const local = asset.livePhotoVideoId ? ctx.store.asset(asset.livePhotoVideoId)?.local : undefined;
    if (local && on.exists(local)) return local;
  }
  if (isVideo(ready.unit)) return undefined;
  const stem = basename(ready.unit, extname(ready.unit)).toLowerCase();
  return on
    .list(dirname(ready.unit))
    .filter((name) => isVideo(name) && basename(name, extname(name)).toLowerCase() === stem)
    .map((name) => join(dirname(ready.unit), name))[0];
}

/** Files a batch of ready units. In a dry run, only plans them, and says what it would do. */
export async function fileBatch(ctx: ReconcileContext, ready: readonly ReadyUnit[], on: Disk = disk): Promise<FilingReport> {
  const report: FilingReport = { filed: [], problems: [] };
  const filings = new FilingStore(ctx.store.db);
  const taken = new Set<string>();
  const planned: { plan: UnitPlan; ready: ReadyUnit; oldAssets: { account: string; id: string }[] }[] = [];
  for (const unit of ready) {
    const liveVideo = liveVideoOf(ctx, unit, on);
    const copy = unit.copies[0]?.asset;
    const result = planUnit(
      ctx.config,
      {
        unit: unit.unit,
        title: unit.title,
        creator: unit.creator,
        date: unit.date,
        ...(copy ? { immich: { localDateTime: copy.localDateTime, fileCreatedAt: copy.fileCreatedAt, timeZone: copy.exifInfo?.timeZone } } : {}),
        ...(liveVideo ? { liveVideo } : {}),
      },
      taken,
      on,
    );
    if ("problem" in result) {
      report.problems.push({ unit: unit.unit, problem: result.problem });
      continue;
    }
    const oldAssets = [unit.unit, ...(liveVideo ? [liveVideo] : [])].flatMap((path) => ctx.store.assetsAt(path).map((record) => ({ account: record.account, id: record.id })));
    planned.push({ plan: result.plan, ready: unit, oldAssets });
  }
  if (ctx.dryRun) {
    for (const { plan } of planned) log.info("would file", { unit: plan.unit, to: plan.destination, files: plan.moves.length });
    report.filed.push(...planned.map(({ plan }) => ({ unit: plan.unit, destination: plan.destination })));
    return report;
  }
  if (planned.length === 0) return report;

  // The whole batch is recorded before anything moves.
  filings.plan(planned.map(({ plan, oldAssets }) => ({ unit: plan.unit, destination: plan.destination, moves: plan.moves, oldAssets })));
  for (const { plan, ready: unit } of planned) {
    const outcome = await fileUnit(ctx, filings, plan, unit.sidecar);
    if (outcome.problem) report.problems.push({ unit: plan.unit, problem: outcome.problem });
    else report.filed.push({ unit: plan.unit, destination: plan.destination });
  }
  await scanLibraries(ctx, planned.flatMap(({ plan }) => [plan.unit, plan.destination]));
  return report;
}

/**
 * Finishes the plans a run left unfinished. Those that met a problem wait for a person, and are tried again only with
 * `retryProblems` (the daemon's first run), so they're not reported every minute.
 */
export async function finishPlanned(ctx: ReconcileContext, options: { retryProblems: boolean }): Promise<FilingReport> {
  const report: FilingReport = { filed: [], problems: [] };
  if (ctx.dryRun) return report;
  const filings = new FilingStore(ctx.store.db);
  const unfinished = filings.withStatus("planned").filter((record) => options.retryProblems || record.problem === undefined);
  for (const record of unfinished) {
    log.info("finishing a filing cut short", { unit: record.unit, to: record.destination });
    const outcome = await fileUnit(ctx, filings, { unit: record.unit, destination: record.destination, moves: record.moves });
    if (outcome.problem) report.problems.push({ unit: record.unit, problem: outcome.problem });
    else report.filed.push({ unit: record.unit, destination: record.destination });
  }
  if (unfinished.length > 0) await scanLibraries(ctx, unfinished.flatMap((record) => [record.unit, record.destination]));
  return report;
}

/** What a file is: its inode and device, or undefined if it isn't there. */
function identity(path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat && `${stat.dev}:${stat.ino}`;
}

/**
 * One unit: `Promote` out of its sidecar, every file linked at its new name, then the old names removed, then the
 * unit's record carried over. Safe to run again on a unit part done. A problem leaves the unit planned, for a person:
 * a name taken by another file, or a file gone.
 *
 * `ready` is the sidecar as it was when the unit was found ready: if it has changed since, nothing moves, and the unit
 * is looked at afresh next time. Finishing a plan cut short reads the sidecar as it is.
 */
async function fileUnit(ctx: ReconcileContext, filings: FilingStore, plan: UnitPlan, ready?: Sidecar): Promise<{ problem?: string }> {
  // 1. Promote and Promote/Needs a title out of the sidecar, and its Darktable duplicates', wherever each is now, so the
  // new copies arrive without them. exiftool writes a new file, so a sidecar already linked at its new name loses its
  // old name first.
  const untouched = plan.moves.every((move) => identity(move.from) && !identity(move.to));
  const sidecar = `${plan.unit}.xmp`;
  const sidecarMoves = plan.moves.filter((move) => move.from === sidecar || isDuplicateSidecar(plan.unit, move.from));
  for (const move of sidecarMoves) {
    const changed = await withoutPromote(ctx, move, move.from === sidecar ? ready : undefined);
    if (changed) {
      // Someone is at it: if nothing has moved yet, the unit is looked at afresh, ready or not, next time.
      if (untouched) filings.forget(plan.unit);
      return { problem: "its sidecar changed just before it was moved" };
    }
  }

  // 2. Every file at its new name, checking each name holds this very file, then the old names removed.
  for (const move of plan.moves) {
    const [from, to] = [identity(move.from), identity(move.to)];
    if (from && to && from !== to) return fail(filings, plan, `${move.to} is another file already`);
    if (!from && !to) return fail(filings, plan, `${move.from} is gone`);
    if (from && !to) {
      mkdirSync(dirname(move.to), { recursive: true });
      try {
        linkSync(move.from, move.to);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return fail(filings, plan, code === "EXDEV" ? `${move.to} is on another filesystem` : `couldn't link ${move.to}: ${(error as Error).message}`);
      }
    }
  }
  for (const move of plan.moves) if (identity(move.from) && identity(move.from) === identity(move.to)) unlinkSync(move.from);

  // 3. The sync records move too: the base of the next merge, and what the daemon made.
  for (const move of plan.moves.filter((each) => !each.from.endsWith(".xmp"))) carryRecord(ctx, move);
  filings.setStatus(plan.unit, "restoring");
  log.info("filed", { unit: plan.unit, to: plan.destination, files: plan.moves.length });
  return {};
}

/** Whether a path is one of a media file's Darktable duplicates' sidecars: `<stem>_01.<ext>.xmp` beside `<stem>.<ext>`. */
function isDuplicateSidecar(unit: string, path: string): boolean {
  const extension = extname(unit);
  const stem = basename(unit, extension);
  return dirname(path) === dirname(unit) && new RegExp(`^${RegExp.escape(stem)}_\\d{2,}${RegExp.escape(extension)}\\.xmp$`).test(basename(path));
}

/**
 * Takes Promote and Promote/Needs a title out of one sidecar about to move, at its old name or its new one. True if it
 * changed meanwhile: `ready` (the sidecar as it was when the unit was found ready) has changed since, or it changed
 * while being written.
 */
async function withoutPromote(ctx: ReconcileContext, move: Move, ready?: Sidecar): Promise<boolean> {
  const [from, to] = [identity(move.from), identity(move.to)];
  if (from && from === to) unlinkSync(move.from);
  const sidecar = ready ?? (await readSidecar(ctx.exiftool, from && from !== to ? move.from : move.to));
  if (!sidecar) return false;
  if (ready !== undefined && !sameStamp(stampOf(ready.path), ready.stamp)) return true;
  const before = darktableReads(sidecar.fields).tags;
  const tags = before.filter((tag) => tag !== PROMOTE_TAG && tag !== NEEDS_TITLE_TAG);
  return tags.length !== before.length && (await writeSidecar(ctx.exiftool, sidecar, { tags })).status === "changed-meanwhile";
}

function fail(filings: FilingStore, plan: UnitPlan, problem: string): { problem: string } {
  log.warn("couldn't file a unit; it's left as planned, for a person to look at", { unit: plan.unit, problem });
  filings.setStatus(plan.unit, "planned", problem);
  return { problem };
}

/** A media file's sync record, moved to its new path with its sidecar's stamp there. */
function carryRecord(ctx: ReconcileContext, move: Move): void {
  const record = ctx.store.unit(move.from);
  if (!record) return;
  const stamp = stampOf(`${move.to}.xmp`);
  ctx.store.putUnits([{ path: move.to, ...(stamp ? { sidecar: stamp } : {}), synced: record.synced, updated: new Date().toISOString() }]);
  ctx.store.removeUnit(move.from);
}

/**
 * Asks Immich to scan the libraries holding these paths, so it sees the new files and the old ones gone. Scans need
 * the admin's session; without it, Immich sees the move at its next scan.
 */
async function scanLibraries(ctx: ReconcileContext, paths: readonly string[]): Promise<void> {
  const admin = [...ctx.accounts.values()].find((account) => account.isAdmin);
  if (!admin) {
    log.warn("the admin's session isn't open, so Immich sees filed units at its next scan of the libraries");
    return;
  }
  const map = new PathMap(ctx.config.immich.pathMap);
  const immichPaths = paths.flatMap((path) => map.toImmich(path) ?? []);
  const holds = (folder: string, path: string) => path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
  for (const library of await listLibraries(admin.client)) {
    if (immichPaths.some((path) => library.importPaths.some((folder) => holds(folder, path)))) await scanLibrary(admin.client, library.id);
  }
}
