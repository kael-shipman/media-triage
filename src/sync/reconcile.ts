// Reconciling units (DESIGN.md, section 5): read the sidecar, each copy and the last-synced record; merge; write the
// sidecar's changed fields; tell Immich (refresh, trash, restore), in bulk per account; record the result. Filing,
// the section's last step, is milestone 8.
//
// A dry run reads and merges, and reports what it would write, but writes, records and changes nothing.
//
// A copy asked to refresh is catching up until it has read the sidecar: until then, what it says of the sidecar's
// values is an older sidecar's, not a change made in Immich, so it isn't a side for them. Otherwise the daemon's next
// look at the unit, a moment after its own write, would read a tag it had just removed as one that copy added, and put
// it back. It has caught up once it holds what it would read from the sidecar it was asked to read, or from the
// sidecar now (an edit in Immich rewrites the sidecar), or once its `updatedAt` changed a moment ago or more: Immich's
// metadata extraction updates the asset, alongside its tags and EXIF (`metadata.service.ts`).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { type FacesOutcome, type NamedFace, applyFaces } from "../core/faces.ts";
import { readiness, withNeedsTitle } from "../core/filing.ts";
import { type Base, type Side, type SideValues, mergeUnit, normalizeDescription, normalizeRating } from "../core/merge.ts";
import { isDarktableInternalInImmich, sameTags } from "../core/tags.ts";
import { withTitle } from "../core/titles.ts";
import { PROMOTE_TAG } from "../core/naming.ts";
import { type AccountState, type ImageFacts, type Wanted, type XmpFields, darktableReads, dateFromImmich, hasDate, imageTags, immichReads, immichReadsImageTags, offsetFromImmich, sameDate } from "../core/xmp.ts";
import { type Asset, getAsset, refreshMetadata, restoreAssets, trashAssets } from "../immich/assets.ts";
import { log } from "../log.ts";
import type { Exiftool } from "../sidecars/exiftool.ts";
import { createSidecar, readSidecar, type Sidecar, writeSidecar } from "../sidecars/sidecar.ts";
import type { OpenAccount } from "../upkeep/accounts.ts";
import type { Asked, AssetRecord, SyncStore, SyncedValues } from "./store.ts";

export interface ReconcileContext {
  config: Config;
  store: SyncStore;
  exiftool: Exiftool;
  /** The open accounts, by configured name. */
  accounts: ReadonlyMap<string, OpenAccount>;
  dryRun: boolean;
  /** Copies asked to refresh that may be catching up, by asset ID. Kept between runs. */
  refreshing: Map<string, Refreshing>;
}

/** A copy asked to refresh: when (ms), its `updatedAt` then, and the sidecar's fields it was asked to read. */
export interface Refreshing {
  at: number;
  updatedAt: string;
  fields: XmpFields;
}

/** How long after an asset's update its metadata extraction is taken to be done: tags are replaced in a parallel step. */
const EXTRACTED_MS = 2000;

/** How long a copy may take to read its sidecar after a refresh before what it says counts again. */
export const CATCH_UP_MS = 60 * 60_000;

/**
 * How long a copy asked to read a sidecar, and not updated since, waits before it's asked again: the request may have
 * been lost (Immich's queue emptied, say). A longer queue only waits (`askable`).
 */
export const ASK_AGAIN_MS = 24 * 60 * 60_000;

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
  /** Inbox units ready to file (DESIGN.md, section 7)… */
  ready: ReadyUnit[];
  /** …and those tagged `Promote` that aren't yet, with why, and when to look again if it's a matter of time. */
  notReady: { unit: string; why: string; inMs?: number }[];
}

/** An inbox unit that's ready to file, with what filing needs. */
export interface ReadyUnit {
  unit: string;
  sidecar: Sidecar;
  title: string;
  creator: string | null;
  /** The capture time as the merge has it, or null: filing then goes by Immich's. */
  date: string | null;
  copies: { account: string; asset: Asset }[];
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

/** Visibilities a person chose: archived and locked. "hidden" is Immich's own, for a Live Photo's video. */
const chosenVisibility = (visibility: string) => (visibility === "archive" || visibility === "locked" ? visibility : "timeline");

/**
 * Each account's state for a unit (F9), from its copies: what the API says of each one it could read, or, for a locked
 * copy, which Immich won't show without the account's PIN, what the stream said. Albums are those the store holds the
 * copy in. An account with no copy to go by (its session isn't open, or the copy is gone) keeps what the sidecar has.
 */
export function accountStates(
  store: SyncStore,
  records: readonly AssetRecord[],
  read: ReadonlyMap<string, Asset>,
  current: readonly AccountState[],
): AccountState[] {
  const known = new Map<string, AccountState>();
  for (const record of records) {
    const asset = read.get(record.id);
    if (!asset && record.visibility !== "locked") continue;
    const state = known.get(record.owner) ?? { user: record.owner, favorite: false, visibility: "timeline", albums: [] };
    state.favorite ||= asset ? asset.isFavorite : record.favorite;
    if (state.visibility === "timeline") state.visibility = chosenVisibility(asset?.visibility ?? record.visibility);
    for (const album of store.albumsOf(record.id)) if (!state.albums.some((held) => held.id === album.id)) state.albums.push(album);
    known.set(record.owner, state);
  }
  return [...current.filter((entry) => !known.has(entry.user)), ...known.values()];
}

/**
 * The named faces on a unit's copies (F10), from the store: visible faces that aren't deleted, whose person the copy's
 * account names and doesn't hide. Each person's faces come from the first copy that has them, so copies that are twins
 * don't show each face twice.
 */
export function namedFaces(store: SyncStore, records: readonly AssetRecord[]): NamedFace[] {
  const chosen = new Map<string, string>();
  const faces: NamedFace[] = [];
  for (const record of records) {
    for (const face of store.facesOn(record.id)) {
      if (!face.visible || face.deleted !== null || face.person === null) continue;
      const from = chosen.get(face.person);
      if (from !== undefined && from !== record.id) continue;
      const person = store.person(record.account, face.person);
      if (!person || person.name.trim() === "" || person.hidden) continue;
      chosen.set(face.person, record.id);
      faces.push({ person: face.person, name: person.name, face });
    }
  }
  return faces;
}

/** Whether Immich would read the same from two versions of a sidecar. */
function sameImmichView(a: XmpFields, b: XmpFields): boolean {
  const [x, y] = [immichReads(a), immichReads(b)];
  return (
    sameTags(x.tags, y.tags) &&
    normalizeRating(x.rating) === normalizeRating(y.rating) &&
    normalizeDescription(x.description) === normalizeDescription(y.description) &&
    (x.date === undefined || y.date === undefined ? x.date === y.date : sameDate(x.date, y.date))
  );
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

/**
 * Whether a copy asked to refresh hasn't read the sidecar yet (see the top of this file), within `CATCH_UP_MS`. A copy
 * that caught up, or ran out of time, is forgotten.
 */
function isCatchingUp(refreshing: Map<string, Refreshing>, copy: Copy, fields: XmpFields | undefined): boolean {
  const asked = refreshing.get(copy.asset.id);
  if (asked === undefined) return false;
  const extracted = copy.asset.updatedAt !== asked.updatedAt && Date.now() - Date.parse(copy.asset.updatedAt) >= EXTRACTED_MS;
  const caughtUp = extracted || copyInStep(copy.asset, asked.fields) || (fields !== undefined && copyInStep(copy.asset, fields));
  if (!caughtUp) {
    if (Date.now() - asked.at < CATCH_UP_MS) return true;
    log.warn("a copy still hasn't read its sidecar, an hour after it was asked to; what it says counts again", { asset: copy.asset.id, account: copy.record.account });
  }
  refreshing.delete(copy.asset.id);
  return false;
}

/** The inbox source a unit is in, if it's in one. */
function sourceOf(config: Config, unit: string): { creator: string } | undefined {
  if (!config.paths.inbox) return undefined;
  return config.sources.find((source) => unit.startsWith(`${join(config.paths.inbox!, source.folder)}/`));
}

export async function reconcile(ctx: ReconcileContext, units: readonly string[]): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    units: units.length,
    written: [],
    created: [],
    unread: [],
    refreshed: 0,
    trashed: [],
    restored: [],
    conflicts: [],
    waiting: [],
    ready: [],
    notReady: [],
  };
  const refresh = new Map<OpenAccount, Set<string>>();
  const trash = new Map<OpenAccount, Set<string>>();
  const restore = new Map<OpenAccount, Set<string>>();
  const add = (map: Map<OpenAccount, Set<string>>, account: OpenAccount, id: string) => map.set(account, (map.get(account) ?? new Set()).add(id));
  const asked = new Map<string, { unit: string; fields: XmpFields; updatedAt: string; sidecar: string | undefined }>();
  // Copies never looked at again since they were asked would otherwise be kept for good.
  for (const [id, { at }] of ctx.refreshing) if (Date.now() - at >= CATCH_UP_MS) ctx.refreshing.delete(id);

  for (const unit of units) {
    try {
      await reconcileUnit(ctx, unit, report, {
        refresh: (copy, fields, sidecar) => {
          add(refresh, copy.account, copy.asset.id);
          asked.set(copy.asset.id, { unit, fields, updatedAt: copy.asset.updatedAt, sidecar });
        },
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
    if (ctx.dryRun) continue;
    await refreshMetadata(account.client, [...ids]);
    const now = Date.now();
    for (const id of ids) {
      const { fields, updatedAt } = asked.get(id)!;
      ctx.refreshing.set(id, { at: now, fields, updatedAt });
    }
    recordAsked(ctx.store, [...ids].map((id) => ({ id, ...asked.get(id)! })), new Date(now).toISOString());
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

/** Records, once Immich took the requests, which sidecar each copy was asked to read, in its unit's record. */
function recordAsked(store: SyncStore, copies: { id: string; unit: string; updatedAt: string; sidecar: string | undefined }[], at: string): void {
  const byUnit = new Map<string, Record<string, Asked>>();
  for (const { id, unit, updatedAt, sidecar } of copies) {
    if (sidecar !== undefined) byUnit.set(unit, { ...byUnit.get(unit), [id]: { sidecar, updatedAt, at } });
  }
  const records = [...byUnit].flatMap(([unit, asked]) => {
    const record = store.unit(unit);
    return record ? [{ ...record, synced: { ...record.synced, asked: { ...record.synced.asked, ...asked } } }] : [];
  });
  store.putUnits(records);
}

/** The sidecar's content, as a hash, if it's there. */
function contentOf(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

async function reconcileUnit(
  ctx: ReconcileContext,
  unit: string,
  report: ReconcileReport,
  tell: { refresh: (copy: Copy, fields: XmpFields, sidecar: string | undefined) => void; trash: (copy: Copy) => void; restore: (copy: Copy) => void },
): Promise<void> {
  const { store, exiftool, dryRun } = ctx;
  const sidecarPath = `${unit}.xmp`;
  const previous = store.unit(unit);

  // F11: the media file is gone. If its sidecar was left behind, the full pass deletes it after the grace period.
  if (!existsSync(unit)) {
    if (previous && !dryRun) store.markGone(unit, new Date().toISOString());
    return;
  }

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
  const records = store.assetsAt(unit).filter((record) => ctx.accounts.has(record.account));
  for (const record of records) {
    const account = ctx.accounts.get(record.account)!;
    const asset = await getAsset(account.client, record.id);
    if (asset) copies.push({ record, account, asset });
  }

  const base: Base | undefined = previous?.synced;

  // The image file's own tags and date, where Immich may show them instead of the sidecar's (section 5): on first
  // contact, where the sidecar has no `TagsList`, and where it has no date.
  const image: ImageFacts | undefined =
    copies.length > 0 && (base === undefined || fields?.tagsList === undefined || !hasDate(fields)) ? await exiftool.readImage(unit) : undefined;
  // On first contact, a tag a copy holds only because the image file embeds it isn't one added in Immich: an edit there
  // writes `TagsList` to the sidecar. The sidecar decides those, as Darktable read them from the image at import.
  // Otherwise the union would bring back every embedded tag since reorganized in Darktable.
  const embedded = base === undefined && fields && image ? new Set(imageTags(image)) : undefined;
  const darktableTags = embedded && fields ? new Set(darktableValues(fields).tags) : undefined;
  // Without a date in the sidecar or the image, Immich's is the file's own time (`getDates`): not a capture time.
  const datelessImage = !hasDate(fields) && !image?.hasDate;

  const catchingUp = new Set(copies.filter((copy) => isCatchingUp(ctx.refreshing, copy, fields)).map((copy) => copy.asset.id));
  // A copy the last sync didn't see may have read an older sidecar: once there's a base, it isn't a side for the
  // sidecar's values until it holds what the sidecar says. Otherwise a tag it never had, such as the title tag the
  // daemon wrote before this account's copy was learned, would read as one it removed. Without a base, every copy is
  // a side, so the union never drops a tag.
  const known = base ? previous?.synced.copies : undefined;
  for (const copy of copies) {
    if (known && !known.includes(copy.asset.id) && !(fields && copyInStep(copy.asset, fields))) catchingUp.add(copy.asset.id);
  }
  const sides: Side[] = copies.map((copy) => {
    const values = copyValues(copy.asset);
    if (embedded && values.tags) values.tags = values.tags.filter((tag) => !embedded.has(tag) || darktableTags!.has(tag));
    if (datelessImage) delete values.date;
    // A copy catching up still says whether it's in the trash: that's not from the sidecar.
    // What it said at the last sync: a value it still holds isn't a change (a copy that hasn't read the sidecar, F1,
    // or can't show a reject, keeps saying the same). A copy the last sync didn't see proposes nothing, its trash
    // included: it takes the unit's state, so a new account's copy of a trashed photo is trashed, not a restore.
    const last = previous?.synced.seen?.[copy.asset.id] ?? (known && !known.includes(copy.asset.id) ? values : undefined);
    return {
      name: `${copy.record.account}:${copy.asset.id}`,
      at: Date.parse(copy.asset.updatedAt),
      values: catchingUp.has(copy.asset.id) ? { trashed: values.trashed, offline: values.offline } : values,
      ...(last ? { last } : {}),
    };
  });
  if (fields) sides.unshift({ name: "darktable", at: sidecar?.stamp.mtimeMs ?? 0, sidecar: true, values: darktableValues(fields) });
  if (sides.length === 0) return;

  // 2. Merge.
  const result = mergeUnit(base, previous?.synced.title, sides);
  if ("conflict" in result) {
    report.conflicts.push({ unit, problem: result.conflict });
    return;
  }
  const { merged } = result;

  // While filing puts a unit's state back on its new copies, its per-account state and named faces are held as they
  // are: the new copies have neither yet (section 7, "Holding the unit").
  const held = store.isBeingPutBack(unit);

  // F10: named faces' tags and, for photos, regions, one way from Immich's faces, from every copy the store knows (the
  // faces and names are the store's, so no session is needed). A unit with no copy at all is left as it is.
  let faces: FacesOutcome | undefined;
  const allRecords = store.assetsAt(unit);
  if (fields && allRecords.length > 0 && !held) {
    const shown = copies[0]?.asset;
    const orientation = Number(shown?.exifInfo?.orientation ?? undefined);
    faces = applyFaces({
      tags: merged.tags,
      faces: namedFaces(store, allRecords),
      photo: shown?.type === "IMAGE",
      orientation: Number.isFinite(orientation) ? orientation : undefined,
      regions: fields.regions,
      made: { tags: previous?.synced.people ?? [], regions: previous?.synced.regions ?? [] },
    });
    merged.tags = faces.tags;
  }
  // Section 7: an inbox unit tagged Promote without a title says so, in both tools.
  if (source) merged.tags = withNeedsTitle(merged.tags, merged.title);

  // 3. Write the sidecar's changed fields, if the file is still as it was read.
  let stamp = sidecar?.stamp;
  let written = false;
  if (fields) {
    const wanted: Wanted = { tags: merged.tags, title: merged.title };
    if (image && immichReadsImageTags(fields, image)) wanted.tagsList = true;
    if (normalizeRating(fields.rating) !== merged.rating) wanted.rating = merged.rating;
    if (normalizeDescription(fields.description) !== merged.description) wanted.description = merged.description;
    if (merged.date !== null) {
      wanted.date = merged.date;
      wanted.offset = copies.map((copy) => offsetFromImmich({ ...copy.asset, timeZone: copy.asset.exifInfo?.timeZone })).find((offset) => offset !== undefined);
    }
    if (merged.gps !== null) wanted.gps = merged.gps;
    if (source && !fields.creator?.length) wanted.creator = source.creator;
    if (!held) wanted.accounts = accountStates(store, records, new Map(copies.map((copy) => [copy.asset.id, copy.asset])), fields.accounts ?? []);
    if (faces?.regions) wanted.regions = faces.regions;
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
        written = true;
      }
    }
  }

  // 4. Tell Immich: after a write, every copy reads the changed sidecar again (F1); otherwise, copies that don't hold
  // what they'd read from it. Either way, only a copy not already asked to read this sidecar (`askable`). Trash follows
  // (F8).
  const content = fields ? contentOf(sidecarPath) : undefined;
  const differs = new Set<string>();
  const askable = (copy: Copy): boolean => {
    // A copy asked to read this sidecar before that read it and still differs always will: Immich takes some values
    // from elsewhere (such as the image file's own description). One not updated since is still waiting for its read:
    // asking again would only queue another, and each read's events bring the unit back here. It's asked again a day
    // on, in case the request was lost.
    const last = previous?.synced.asked?.[copy.asset.id];
    if (content === undefined || last?.sidecar !== content) return true;
    if (copy.asset.updatedAt === last.updatedAt) return Date.now() - Date.parse(last.at) >= ASK_AGAIN_MS;
    if (!last.differs) {
      log.info("a copy updated since it was asked to read its sidecar still differs from it (Immich may show some values from elsewhere): it's asked again when the sidecar changes", {
        unit,
        account: copy.record.account,
        asset: copy.asset.id,
      });
    }
    differs.add(copy.asset.id);
    return false;
  };
  for (const copy of copies) {
    // A copy catching up is asked again if the sidecar changed since it was asked: what it will read is out of date.
    // One never asked (newly seen) is asked if it doesn't hold what the sidecar says.
    const asked = catchingUp.has(copy.asset.id) ? ctx.refreshing.get(copy.asset.id) : undefined;
    const wanted = written || (fields !== undefined && (asked ? !sameImmichView(asked.fields, fields) : !copyInStep(copy.asset, fields)));
    if (fields && wanted && askable(copy)) tell.refresh(copy, fields, content);
    if (copy.asset.isOffline) continue;
    if (merged.trashed && !copy.asset.isTrashed) tell.trash(copy);
    if (!merged.trashed && copy.asset.isTrashed) tell.restore(copy);
  }

  // 5. Record what every side now says, with the sidecar's stamp, so the daemon's own writes aren't acted on again.
  if (!dryRun) {
    const { from: _, ...values } = merged;
    const synced: SyncedValues = {
      ...values,
      creator: fields?.creator?.[0] ?? null,
      people: faces?.madeTags ?? previous?.synced.people ?? [],
      regions: faces?.madeRegions ?? previous?.synced.regions ?? [],
      copies: copies.map((copy) => copy.asset.id),
      seen: Object.fromEntries(copies.map((copy) => [copy.asset.id, copyValues(copy.asset)])),
    };
    // What each copy was asked to read before; the requests made now are added once Immich takes them (`recordAsked`).
    const asked = Object.entries(previous?.synced.asked ?? {}).flatMap(([id, entry]): [string, Asked][] =>
      synced.copies!.includes(id) ? [[id, differs.has(id) ? { ...entry, differs: true } : entry]] : [],
    );
    if (asked.length > 0) synced.asked = Object.fromEntries(asked);
    store.putUnits([{ path: unit, ...(stamp ? { sidecar: stamp } : {}), synced, updated: new Date().toISOString() }]);
  }

  // 6. Filing (section 7): whether an inbox unit tagged Promote is ready, for the filing job.
  if (source && sidecar && fields && merged.tags.includes(PROMOTE_TAG)) {
    const unreadable = allRecords.filter((record) => !ctx.accounts.has(record.account)).length;
    const state = readiness({
      tags: merged.tags,
      title: merged.title,
      rating: fields.rating,
      copies: copies.map((copy) => ({
        trashed: copy.asset.isTrashed,
        inStep: copyInStep(copy.asset, fields!),
        catchingUp: catchingUp.has(copy.asset.id),
        changedAt: Date.parse(copy.asset.updatedAt),
      })),
      unreadable,
      sidecarChangedAt: stamp?.mtimeMs ?? 0,
      settleMs: ctx.config.timing.settleMs,
      now: Date.now(),
    });
    if (state.ready) {
      const current = stamp === sidecar.stamp ? sidecar : { path: sidecar.path, stamp: stamp!, fields };
      report.ready.push({
        unit,
        sidecar: current,
        title: merged.title!,
        creator: fields.creator?.[0] ?? null,
        date: merged.date,
        copies: copies.map((copy) => ({ account: copy.record.account, asset: copy.asset })),
      });
    } else report.notReady.push({ unit, why: state.why, ...(state.inMs !== undefined ? { inMs: state.inMs } : {}) });
  }
}
