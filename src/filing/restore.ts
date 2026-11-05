// Putting back what Immich keeps per asset, on a filed unit's new copies (DESIGN.md, section 7): each account's
// favorite, visibility and albums, from the sidecar's per-account state (F9), and the face corrections, from the old
// copies' faces in the state. The unit is held meanwhile (src/sync/reconcile.ts), and released once this is done.
//
// Every step looks at what the new copy says first, so running it again changes nothing that's already so. It waits,
// up to `RESTORE_LIMIT_MS` after the move, for what Immich hasn't done yet: indexing the new path, detecting and
// recognizing the faces there, taking the old copies offline. Then it does what it can, and reports the rest.

import { type AssetVisibility } from "@immich/sdk";
import { existsSync } from "node:fs";
import { type NewFace, type OldFace, awaitingDetection, faceActions } from "../core/face-match.ts";
import { PathMap } from "../core/path-map.ts";
import type { AccountState } from "../core/xmp.ts";
import { addToAlbum, listAlbums } from "../immich/albums.ts";
import { type Asset, findByPaths, getAsset, setFavorite, setVisibility } from "../immich/assets.ts";
import { createFace, deleteFace, getFaces, reassignFace } from "../immich/faces.ts";
import { libraryQueueIdle } from "../immich/libraries.ts";
import { log } from "../log.ts";
import { readSidecar } from "../sidecars/sidecar.ts";
import type { ReconcileContext } from "../sync/reconcile.ts";
import type { OpenAccount } from "../upkeep/accounts.ts";
import { type FilingRecord, FilingStore } from "./store.ts";

/** How long after the move to wait for Immich, before doing what can be done and reporting the rest. */
export const RESTORE_LIMIT_MS = 60 * 60_000;
/** How long after the move missing copies are taken to be missing for good, once Immich's library queue is idle. */
const INDEXED_MS = 2 * 60_000;

export interface RestoreReport {
  /** Units put back, with what couldn't be. */
  done: { unit: string; problems: string[] }[];
  /** Units still waiting for Immich, and for what. */
  waiting: { unit: string; why: string }[];
}

type Outcome = { waiting: string } | { problems: string[] };

export async function restorePending(ctx: ReconcileContext): Promise<RestoreReport> {
  const report: RestoreReport = { done: [], waiting: [] };
  if (ctx.dryRun) return report;
  const filings = new FilingStore(ctx.store.db);
  const pending = filings.withStatus("restoring");
  if (pending.length === 0) return report;
  const admin = [...ctx.accounts.values()].find((account) => account.isAdmin);
  const queueIdle = admin ? await libraryQueueIdle(admin.client) : false;
  for (const record of pending) {
    const outcome = await restoreUnit(ctx, record, queueIdle);
    if ("waiting" in outcome) {
      report.waiting.push({ unit: record.unit, why: outcome.waiting });
      continue;
    }
    filings.setStatus(record.unit, "done", outcome.problems.length > 0 ? outcome.problems.join("; ") : undefined);
    report.done.push({ unit: record.unit, problems: outcome.problems });
    log.info("put back", { unit: record.destination, problems: outcome.problems.length > 0 ? outcome.problems.join("; ") : undefined });
  }
  return report;
}

async function restoreUnit(ctx: ReconcileContext, record: FilingRecord, queueIdle: boolean): Promise<Outcome> {
  const elapsed = Date.now() - Date.parse(record.updated);
  const late = elapsed >= RESTORE_LIMIT_MS;
  if (!existsSync(record.destination)) return { problems: ["the filed file is gone, so nothing was put back"] };

  // The accounts that had a copy, by name, each with its session.
  const accounts = new Map<string, OpenAccount>();
  for (const name of new Set(record.oldAssets.map((asset) => asset.account))) {
    const account = ctx.accounts.get(name);
    if (!account) {
      if (!late) return { waiting: `account ${name} isn't open` };
      continue;
    }
    accounts.set(name, account);
  }

  // Each account's new copy. One missing is waited for, unless Immich has finished scanning: its libraries may leave
  // the new path out (a date limit, say).
  const immichPath = new PathMap(ctx.config.immich.pathMap).toImmich(record.destination);
  if (!immichPath) return { problems: ["the new path isn't in the path map, so Immich's copies can't be found"] };
  const copies = new Map<string, Asset>();
  for (const [name, account] of accounts) {
    const found = (await findByPaths(account.client, [immichPath])).find((asset) => asset.ownerId === account.userId);
    if (found) copies.set(name, found);
  }
  const problems: string[] = [];
  const missing = [...accounts.keys()].filter((name) => !copies.has(name));
  if (missing.length > 0) {
    if (!late && !(queueIdle && elapsed >= INDEXED_MS)) return { waiting: `Immich hasn't indexed the new path in ${missing.join(", ")}` };
    problems.push(`no copy at the new path in ${missing.join(", ")}`);
  }

  // Faces first: waiting for them is what takes time, and nothing else is changed until there's no more waiting.
  const facePlans: { name: string; account: OpenAccount; copy: Asset; old: OldFace[]; fresh: NewFace[] }[] = [];
  const corrected = ctx.config.immich.mirrorsFaceCorrections ? [...copies].slice(0, 1) : [...copies];
  for (const [name, copy] of corrected) {
    const account = accounts.get(name)!;
    const oldId = record.oldAssets.find((asset) => asset.account === name)?.id;
    const old: OldFace[] = (oldId ? ctx.store.facesOn(oldId) : [])
      .filter((face) => face.visible || face.deleted !== null)
      .map((face) => ({ ...face, deleted: face.deleted !== null }));
    const fresh: NewFace[] = (await getFaces(account.client, copy.id)).map((face) => ({ ...face, person: face.person?.id ?? null }));
    if (awaitingDetection(old, fresh) && !late) return { waiting: "Immich hasn't detected and recognized the faces at the new path yet" };
    facePlans.push({ name, account, copy, old, fresh });
  }

  // Favorites, visibility and albums (F9), from the sidecar, which moved with the file.
  const sidecar = await readSidecar(ctx.exiftool, `${record.destination}.xmp`);
  for (const entry of sidecar?.fields.accounts ?? []) {
    const name = [...accounts].find(([, account]) => account.userId === entry.user)?.[0];
    const copy = name ? copies.get(name) : undefined;
    if (!name || !copy) {
      problems.push(`the favorite, visibility and albums of user ${entry.user} weren't put back: it has no copy at the new path`);
      continue;
    }
    problems.push(...(await putBackState(accounts.get(name)!, copy, entry)));
  }

  for (const { name, account, copy, old, fresh } of facePlans) problems.push(...(await putBackFaces(name, account, copy, old, fresh)));

  // The old copies: offline or gone, read through the API only.
  for (const { account: name, id } of record.oldAssets) {
    const account = accounts.get(name);
    if (!account) continue;
    const asset = await getAsset(account.client, id);
    if (asset && !asset.isOffline) {
      if (!late) return { waiting: "Immich hasn't taken the old copies offline yet" };
      problems.push(`the old copy ${id} in ${name} is still online`);
    }
  }
  return { problems };
}

async function putBackState(account: OpenAccount, copy: Asset, entry: AccountState): Promise<string[]> {
  const problems: string[] = [];
  const name = account.account.name;
  try {
    if (entry.favorite && !copy.isFavorite) await setFavorite(account.client, [copy.id], true);
    if (entry.visibility !== "timeline" && copy.visibility !== entry.visibility) await setVisibility(account.client, [copy.id], entry.visibility as AssetVisibility);
  } catch (error) {
    problems.push(`${name}: couldn't put back the favorite or visibility: ${(error as Error).message}`);
  }
  if (entry.albums.length === 0) return problems;
  const holding = new Set((await listAlbums(account.client, { assetId: copy.id })).map((album) => album.id));
  for (const album of entry.albums.filter((each) => !holding.has(each.id))) {
    try {
      const failed = await addToAlbum(account.client, album.id, [copy.id]);
      if (failed.length > 0) problems.push(`${name}: couldn't put it back in album "${album.name}": ${failed[0]!.reason}`);
    } catch (error) {
      problems.push(`${name}: couldn't put it back in album "${album.name}": ${(error as Error).message}`);
    }
  }
  return problems;
}

async function putBackFaces(name: string, account: OpenAccount, copy: Asset, old: OldFace[], fresh: NewFace[]): Promise<string[]> {
  const problems: string[] = [];
  for (const action of faceActions(old, fresh)) {
    try {
      switch (action.kind) {
        case "reassign":
          await reassignFace(account.client, action.face, action.person);
          break;
        case "add": {
          const { box } = action;
          await createFace(account.client, {
            assetId: copy.id,
            personId: action.person,
            imageWidth: box.imageWidth,
            imageHeight: box.imageHeight,
            x: box.boundingBoxX1,
            y: box.boundingBoxY1,
            width: box.boundingBoxX2 - box.boundingBoxX1,
            height: box.boundingBoxY2 - box.boundingBoxY1,
          });
          break;
        }
        case "delete":
          await deleteFace(account.client, action.face);
          break;
        case "unmatched":
          problems.push(`${name}: a face of person ${action.person} wasn't found again at the new path`);
          break;
      }
    } catch (error) {
      problems.push(`${name}: couldn't put back a face (${action.kind}): ${(error as Error).message}`);
    }
  }
  return problems;
}
