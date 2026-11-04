// Reconciling units (DESIGN.md, section 5): read the sidecar, each copy and the last-synced record; merge; write the
// sidecar's changed fields; tell Immich (refresh, trash, restore), in bulk per account; record the result. Filing,
// the section's last step, is milestone 8.
//
// A dry run reads and merges, and reports what it would write, but writes, records and changes nothing.

import { join } from "node:path";
import type { Config } from "../config.ts";
import { type Base, type Side, type SideValues, mergeUnit, normalizeDescription, normalizeRating } from "../core/merge.ts";
import { isDarktableInternalInImmich, sameTags } from "../core/tags.ts";
import { withTitle } from "../core/titles.ts";
import { type Wanted, type XmpFields, darktableReads, dateFromImmich, immichReads, offsetFromImmich, sameDate } from "../core/xmp.ts";
import { type Asset, getAsset, refreshMetadata, restoreAssets, trashAssets } from "../immich/assets.ts";
import { log } from "../log.ts";
import type { Exiftool } from "../sidecars/exiftool.ts";
import { createSidecar, readSidecar, type Sidecar, writeSidecar } from "../sidecars/sidecar.ts";
import type { OpenAccount } from "../upkeep/accounts.ts";
import type { AssetRecord, SyncStore, SyncedValues } from "./store.ts";

export interface ReconcileContext {
  config: Config;
  store: SyncStore;
  exiftool: Exiftool;
  /** The open accounts, by configured name. */
  accounts: ReadonlyMap<string, OpenAccount>;
  dryRun: boolean;
}

export interface ReconcileReport {
  units: number;
  /** Sidecars written (or, in a dry run, that would be), with the fields. */
  written: { unit: string; fields: string[] }[];
  /** Minimal sidecars made for F2. */
  created: string[];
  /** Of those, the ones whose copies won't read them: the server doesn't read new sidecars (F1). */
  unread: string[];
  /** Copies told to read their sidecar again (F1). */
  refreshed: number;
  /** Copies trashed and restored to mirror another (F8), by asset ID. */
  trashed: string[];
  restored: string[];
  conflicts: { unit: string; problem: string }[];
  /** Units left for the next pass, and why. */
  waiting: { unit: string; why: string }[];
}

interface Copy {
  record: AssetRecord;
  account: OpenAccount;
  asset: Asset;
}

/** What a copy says, read through the API, in the form the merge compares. */
export function copyValues(asset: Asset): SideValues {
  const exif = asset.exifInfo;
  const latitude = exif?.latitude ?? null;
  const longitude = exif?.longitude ?? null;
  return {
    rating: normalizeRating(exif?.rating),
    description: normalizeDescription(exif?.description),
    tags: (asset.tags ?? []).map((tag) => tag.value).filter((tag) => !isDarktableInternalInImmich(tag)),
    date: exif?.dateTimeOriginal ? dateFromImmich({ localDateTime: asset.localDateTime, fileCreatedAt: asset.fileCreatedAt, timeZone: exif.timeZone }) : null,
    gps: latitude !== null && longitude !== null ? { latitude, longitude } : null,
    trashed: asset.isTrashed,
    offline: asset.isOffline,
  };
}

/** What Darktable shows from a sidecar, in the form the merge compares. */
export function darktableValues(fields: XmpFields): SideValues {
  const view = darktableReads(fields);
  return {
    rating: normalizeRating(fields.rating),
    description: normalizeDescription(fields.description),
    tags: withTitle(view.tags, fields.title),
    date: fields.date ?? fields.immichDate ?? null,
    gps: fields.latitude !== undefined && fields.longitude !== undefined ? { latitude: fields.latitude, longitude: fields.longitude } : null,
  };
}

/** Whether a copy holds what Immich would read from the sidecar, so a refresh would change nothing. */
function copyInStep(asset: Asset, fields: XmpFields): boolean {
  const expected = immichReads(fields);
  const copy = copyValues(asset);
  return (
    sameTags(copy.tags ?? [], expected.tags) &&
    copy.rating === normalizeRating(expected.rating) &&
    copy.description === normalizeDescription(expected.description) &&
    (expected.date === undefined || (copy.date !== null && copy.date !== undefined && sameDate(copy.date, expected.date)))
  );
}

/** The inbox source a unit is in, if it's in one. */
function sourceOf(config: Config, unit: string): { creator: string } | undefined {
  if (!config.paths.inbox) return undefined;
  return config.sources.find((source) => unit.startsWith(`${join(config.paths.inbox!, source.folder)}/`));
}

export async function reconcile(ctx: ReconcileContext, units: readonly string[]): Promise<ReconcileReport> {
  const report: ReconcileReport = { units: units.length, written: [], created: [], unread: [], refreshed: 0, trashed: [], restored: [], conflicts: [], waiting: [] };
  const refresh = new Map<OpenAccount, Set<string>>();
  const trash = new Map<OpenAccount, Set<string>>();
  const restore = new Map<OpenAccount, Set<string>>();
  const add = (map: Map<OpenAccount, Set<string>>, account: OpenAccount, id: string) => map.set(account, (map.get(account) ?? new Set()).add(id));

  for (const unit of units) {
    try {
      await reconcileUnit(ctx, unit, report, {
        refresh: (copy) => add(refresh, copy.account, copy.asset.id),
        trash: (copy) => add(trash, copy.account, copy.asset.id),
        restore: (copy) => add(restore, copy.account, copy.asset.id),
      });
    } catch (error) {
      log.error("couldn't reconcile a unit; it's tried again at the next change or pass", { unit, error: error as Error });
      report.waiting.push({ unit, why: (error as Error).message });
    }
  }

  for (const [account, ids] of trash) {
    report.trashed.push(...ids);
    if (!ctx.dryRun) await trashAssets(account.client, [...ids]);
  }
  for (const [account, ids] of restore) {
    report.restored.push(...ids);
    if (!ctx.dryRun) await restoreAssets(account.client, [...ids]);
  }
  for (const [account, ids] of refresh) {
    report.refreshed += ids.size;
    if (!ctx.dryRun) await refreshMetadata(account.client, [...ids]);
  }

  if (report.written.length + report.created.length + report.refreshed + report.trashed.length + report.restored.length + report.conflicts.length > 0) {
    log.info(ctx.dryRun ? "reconciled (dry run: nothing changed)" : "reconciled", {
      units: report.units,
      sidecars: report.written.length || undefined,
      created: report.created.length || undefined,
      refreshed: report.refreshed || undefined,
      trashed: report.trashed.length || undefined,
      restored: report.restored.length || undefined,
      conflicts: report.conflicts.length || undefined,
      waiting: report.waiting.length || undefined,
    });
  }
  for (const { unit, problem } of report.conflicts) log.warn("conflict: left as it is", { unit, problem });
  if (report.unread.length > 0) {
    log.warn("Immich won't read these new sidecars until the server reads sidecars made after indexing (reads_new_sidecars, F1)", {
      count: report.unread.length,
      first: report.unread[0],
    });
  }
  if (ctx.dryRun) for (const { unit, fields } of report.written.slice(0, 20)) log.info("would write", { unit, fields: fields.join(",") });
  return report;
}

async function reconcileUnit(
  ctx: ReconcileContext,
  unit: string,
  report: ReconcileReport,
  tell: { refresh: (copy: Copy) => void; trash: (copy: Copy) => void; restore: (copy: Copy) => void },
): Promise<void> {
  const { store, exiftool, dryRun } = ctx;
  const sidecarPath = `${unit}.xmp`;

  // 1. Read: the sidecar (making F2's minimal one in an inbox source), each copy, and the last-synced record.
  let sidecar: Sidecar | undefined = await readSidecar(exiftool, sidecarPath);
  const source = sourceOf(ctx.config, unit);
  let fields: XmpFields | undefined = sidecar?.fields;
  if (!sidecar && source) {
    const created = await createSidecar(exiftool, unit, source.creator, { dryRun });
    if (created.status === "created") sidecar = created.sidecar;
    if (created.status === "dry-run") fields = { creator: [source.creator] };
    if (created.status !== "exists") report.created.push(unit);
    if (created.status !== "exists" && !ctx.config.immich.readsNewSidecars && store.assetsAt(unit).length > 0) report.unread.push(unit);
    else sidecar = await readSidecar(exiftool, sidecarPath);
    fields = sidecar?.fields ?? fields;
  }

  const copies: Copy[] = [];
  for (const record of store.assetsAt(unit)) {
    const account = ctx.accounts.get(record.account);
    if (!account) continue;
    const asset = await getAsset(account.client, record.id);
    if (asset) copies.push({ record, account, asset });
  }

  const previous = store.unit(unit);
  const base: Base | undefined = previous?.synced;
  const sides: Side[] = copies.map((copy) => ({ name: `${copy.record.account}:${copy.asset.id}`, at: Date.parse(copy.asset.updatedAt), values: copyValues(copy.asset) }));
  if (fields) sides.unshift({ name: "darktable", at: sidecar?.stamp.mtimeMs ?? 0, values: darktableValues(fields) });
  if (sides.length === 0) return;

  // 2. Merge.
  const result = mergeUnit(base, previous?.synced.title, sides);
  if ("conflict" in result) {
    report.conflicts.push({ unit, problem: result.conflict });
    return;
  }
  const { merged } = result;

  // 3. Write the sidecar's changed fields, if the file is still as it was read.
  let stamp = sidecar?.stamp;
  if (fields) {
    const wanted: Wanted = { tags: merged.tags, title: merged.title };
    if (normalizeRating(fields.rating) !== merged.rating) wanted.rating = merged.rating;
    if (normalizeDescription(fields.description) !== merged.description) wanted.description = merged.description;
    if (merged.date !== null) {
      wanted.date = merged.date;
      wanted.offset = copies.map((copy) => offsetFromImmich({ ...copy.asset, timeZone: copy.asset.exifInfo?.timeZone })).find((offset) => offset !== undefined);
    }
    if (merged.gps !== null) wanted.gps = merged.gps;
    if (source && !fields.creator?.length) wanted.creator = source.creator;
    if (sidecar) {
      const outcome = await writeSidecar(exiftool, sidecar, wanted, { dryRun });
      if (outcome.status === "changed-meanwhile") {
        report.waiting.push({ unit, why: "its sidecar changed while it was reconciled" });
        return;
      }
      if (outcome.status !== "unchanged") report.written.push({ unit, fields: Object.keys(outcome.plan) });
      if (outcome.status === "written") {
        stamp = outcome.stamp;
        fields = (await readSidecar(exiftool, sidecarPath))?.fields ?? fields;
        // 4. Tell Immich: every copy reads the changed sidecar again (F1).
        for (const copy of copies) tell.refresh(copy);
      }
    }
  }

  // 4. Tell Immich: copies that don't hold what they'd read from the sidecar read it again, and trash follows (F8).
  for (const copy of copies) {
    if (fields && !copyInStep(copy.asset, fields)) tell.refresh(copy);
    if (copy.asset.isOffline) continue;
    if (merged.trashed && !copy.asset.isTrashed) tell.trash(copy);
    if (!merged.trashed && copy.asset.isTrashed) tell.restore(copy);
  }

  // 5. Record what every side now says, with the sidecar's stamp, so the daemon's own writes aren't acted on again.
  if (!dryRun) {
    const { from: _, ...values } = merged;
    const synced: SyncedValues = { ...values, creator: fields?.creator?.[0] ?? null };
    store.putUnits([{ path: unit, ...(stamp ? { sidecar: stamp } : {}), synced, updated: new Date().toISOString() }]);
  }
}
