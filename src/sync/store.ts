// What sync keeps between runs (DESIGN.md, sections 3, 5 and 13), in the state database.
//
// - Assets: every Immich asset the daemon knows, with its path. The sync stream carries no paths, and a library
//   asset's path never changes, so each asset is looked up once.
// - Units: for each media file, the values last made equal everywhere (the base of the three-way merge), and its
//   sidecar's stamp when it was last read or written, so the full pass skips a sidecar until it changes again.
//
// Every write is one transaction.

import type { Database } from "bun:sqlite";
import type { FileStamp } from "../sidecars/sidecar.ts";

export interface AssetRecord {
  id: string;
  /** The configured account whose session sees it: its owner's. */
  account: string;
  /** The owner's Immich user ID. */
  owner: string;
  /** The library's ID, or null for an upload. */
  library: string | null;
  /** Immich's path. */
  path: string;
  /** The path here, or null when the path map doesn't cover it. */
  local: string | null;
  trashed: boolean;
  /** Immich's visibility: "timeline", "archive", "locked" or "hidden". */
  visibility: string;
}

/** The values a unit last had everywhere: the base the next merge compares each side with. */
export interface SyncedValues {
  rating: number | null;
  title: string | null;
  description: string | null;
  creator: string | null;
  /** Immich's notation, without Darktable's own tags. */
  tags: string[];
  /** The capture time, with its offset when known. */
  date: string | null;
  gps: { latitude: number; longitude: number } | null;
}

export interface UnitRecord {
  /** The media file, here. */
  path: string;
  /** The sidecar's stamp when it was last read or written, if it has one. */
  sidecar?: FileStamp;
  synced: SyncedValues;
  /** When the record was written (ISO 8601). */
  updated: string;
}

interface AssetRow {
  id: string;
  account: string;
  owner: string;
  library: string | null;
  path: string;
  local: string | null;
  trashed: number;
  visibility: string;
}

interface UnitRow {
  path: string;
  sidecar_size: number | null;
  sidecar_mtime: number | null;
  sidecar_ino: number | null;
  synced: string;
  updated: string;
}

const toAsset = (row: AssetRow): AssetRecord => ({ ...row, trashed: row.trashed === 1 });

function toUnit(row: UnitRow): UnitRecord {
  const sidecar =
    row.sidecar_size === null || row.sidecar_mtime === null || row.sidecar_ino === null
      ? undefined
      : { size: row.sidecar_size, mtimeMs: row.sidecar_mtime, ino: row.sidecar_ino };
  return { path: row.path, ...(sidecar ? { sidecar } : {}), synced: JSON.parse(row.synced) as SyncedValues, updated: row.updated };
}

export class SyncStore {
  constructor(private readonly db: Database) {}

  /** Adds or replaces assets. */
  putAssets(records: readonly AssetRecord[]): void {
    const insert = this.db.query(
      `insert into assets (id, account, owner, library, path, local, trashed, visibility) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set account = excluded.account, owner = excluded.owner, library = excluded.library,
         path = excluded.path, local = excluded.local, trashed = excluded.trashed, visibility = excluded.visibility`,
    );
    this.db.transaction(() => {
      for (const record of records) {
        insert.run(record.id, record.account, record.owner, record.library, record.path, record.local, record.trashed ? 1 : 0, record.visibility);
      }
    })();
  }

  /** Changes what the sync stream reports about known assets, without touching their paths. */
  updateAssets(changes: readonly { id: string; trashed?: boolean; visibility?: string }[]): void {
    const update = this.db.query("update assets set trashed = coalesce(?, trashed), visibility = coalesce(?, visibility) where id = ?");
    this.db.transaction(() => {
      for (const change of changes) update.run(change.trashed === undefined ? null : change.trashed ? 1 : 0, change.visibility ?? null, change.id);
    })();
  }

  asset(id: string): AssetRecord | undefined {
    const row = this.db.query<AssetRow, [string]>("select * from assets where id = ?").get(id);
    return row ? toAsset(row) : undefined;
  }

  /** Which of these IDs aren't known yet. */
  unknownAssets(ids: readonly string[]): string[] {
    const known = this.db.query<{ id: string }, [string]>("select id from assets where id = ?");
    return ids.filter((id) => !known.get(id));
  }

  /** Every copy of a file here, in every account. */
  assetsAt(local: string): AssetRecord[] {
    return this.db.query<AssetRow, [string]>("select * from assets where local = ? order by account, id").all(local).map(toAsset);
  }

  removeAssets(ids: readonly string[]): void {
    const remove = this.db.query("delete from assets where id = ?");
    this.db.transaction(() => {
      for (const id of ids) remove.run(id);
    })();
  }

  /** Forgets an account's assets, as after a reset of its sync stream, before it's read whole again. */
  forgetAccount(account: string): void {
    this.db.query("delete from assets where account = ?").run(account);
  }

  countAssets(account?: string): number {
    const row = account
      ? this.db.query<{ count: number }, [string]>("select count(*) as count from assets where account = ?").get(account)
      : this.db.query<{ count: number }, []>("select count(*) as count from assets").get();
    return row?.count ?? 0;
  }

  unit(path: string): UnitRecord | undefined {
    const row = this.db.query<UnitRow, [string]>("select * from units where path = ?").get(path);
    return row ? toUnit(row) : undefined;
  }

  putUnits(records: readonly UnitRecord[]): void {
    const insert = this.db.query(
      `insert into units (path, sidecar_size, sidecar_mtime, sidecar_ino, synced, updated) values (?, ?, ?, ?, ?, ?)
       on conflict (path) do update set sidecar_size = excluded.sidecar_size, sidecar_mtime = excluded.sidecar_mtime,
         sidecar_ino = excluded.sidecar_ino, synced = excluded.synced, updated = excluded.updated`,
    );
    this.db.transaction(() => {
      for (const record of records) {
        insert.run(record.path, record.sidecar?.size ?? null, record.sidecar?.mtimeMs ?? null, record.sidecar?.ino ?? null, JSON.stringify(record.synced), record.updated);
      }
    })();
  }

  removeUnit(path: string): void {
    this.db.query("delete from units where path = ?").run(path);
  }
}
