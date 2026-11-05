// What sync keeps between runs (DESIGN.md, sections 3, 5 and 13), in the state database.
//
// - Assets: every Immich asset the daemon knows, with its path. The sync stream carries no paths, and a library
//   asset's path never changes, so each asset is looked up once.
// - Units: for each media file, the values last made equal everywhere (the base of the three-way merge), and its
//   sidecar's stamp when it was last read or written, so the full pass skips a sidecar until it changes again.
// - Albums: each account's albums and their assets, as its stream reports them, for each copy's album memberships
//   (F9). Album IDs are the server's, but access is each account's: an account that loses access to an album is told
//   so on its own stream only.
// - Faces and people (F10): every face on every asset in the cluster group, which each account's stream reports, and
//   each account's own record of each person (the person group's ID), with its name. Filing will need an old copy's
//   faces, deleted ones included, after its file has moved.
//
// After a reset of an account's stream, what it reported before is kept but marked stale, and each row it sends again
// is fresh. (Faces are the whole cluster group's, so a reset of any account marks them all.) Once the stream has been read whole, what's still stale is gone (`sweep`). So a reset doesn't empty the
// albums until they're sent again, which would rewrite every sidecar twice.
//
// Every write is one transaction.

import type { Database } from "bun:sqlite";
import type { Base } from "../core/merge.ts";
import type { Area, FaceBox } from "../core/regions.ts";
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
  favorite: boolean;
}

/** An album holding an asset, as some account sees it. */
export interface AlbumRef {
  id: string;
  name: string;
}

/** A face, as the sync stream reports it (`SyncAssetFaceV3`): a box in pixels of the image as shown. */
export interface FaceRecord extends FaceBox {
  id: string;
  asset: string;
  /** The person group's ID, or null for a face no one is assigned to. */
  person: string | null;
  /** "machine-learning", "exif" or "manual". */
  source: string;
  visible: boolean;
  /** When it was deleted (a soft delete), or null. */
  deleted: string | null;
}

/** An account's own record of a person. */
export interface PersonRecord {
  account: string;
  /** The person group's ID: the same in every account of the cluster group. */
  id: string;
  name: string;
  hidden: boolean;
}

/** The values a unit last had everywhere: the base the next merge compares each side with (src/core/merge.ts). */
export interface SyncedValues extends Base {
  title: string | null;
  creator: string | null;
  /** The `People/…` tags the daemon made from faces (F10); others are hand made, and never removed. */
  people?: string[];
  /** The face regions the daemon made (F10), so they can be told from other tools' regions. */
  regions?: { name: string; area: Area }[];
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
  favorite: number;
}

interface UnitRow {
  path: string;
  sidecar_size: number | null;
  sidecar_mtime: number | null;
  sidecar_ino: number | null;
  synced: string;
  updated: string;
}

interface FaceRow {
  id: string;
  asset: string;
  person: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  source: string;
  visible: number;
  deleted: string | null;
}

const toFace = (row: FaceRow): FaceRecord => ({
  id: row.id,
  asset: row.asset,
  person: row.person,
  boundingBoxX1: row.x1,
  boundingBoxY1: row.y1,
  boundingBoxX2: row.x2,
  boundingBoxY2: row.y2,
  imageWidth: row.width,
  imageHeight: row.height,
  source: row.source,
  visible: row.visible === 1,
  deleted: row.deleted,
});

const toAsset = (row: AssetRow): AssetRecord => ({ ...row, trashed: row.trashed === 1, favorite: row.favorite === 1 });

/** The kv key saying an account's stream was reset and its stale rows are to be swept once it's read whole. */
const sweepKey = (account: string) => `sync.sweep.${account}`;

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
      `insert into assets (id, account, owner, library, path, local, trashed, visibility, favorite) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set account = excluded.account, owner = excluded.owner, library = excluded.library,
         path = excluded.path, local = excluded.local, trashed = excluded.trashed, visibility = excluded.visibility,
         favorite = excluded.favorite`,
    );
    this.db.transaction(() => {
      for (const record of records) {
        insert.run(record.id, record.account, record.owner, record.library, record.path, record.local, record.trashed ? 1 : 0, record.visibility, record.favorite ? 1 : 0);
      }
    })();
  }

  /** Changes what the sync stream reports about known assets, without touching their paths. */
  updateAssets(changes: readonly { id: string; trashed?: boolean; visibility?: string; favorite?: boolean }[]): void {
    const update = this.db.query(
      "update assets set trashed = coalesce(?, trashed), visibility = coalesce(?, visibility), favorite = coalesce(?, favorite) where id = ?",
    );
    const flag = (value: boolean | undefined) => (value === undefined ? null : value ? 1 : 0);
    this.db.transaction(() => {
      for (const change of changes) update.run(flag(change.trashed), change.visibility ?? null, flag(change.favorite), change.id);
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

  /** Forgets assets, and their places in albums. */
  removeAssets(ids: readonly string[]): void {
    const remove = this.db.query("delete from assets where id = ?");
    const unalbum = this.db.query("delete from album_assets where asset = ?");
    this.db.transaction(() => {
      for (const id of ids) {
        remove.run(id);
        unalbum.run(id);
      }
    })();
  }

  /**
   * After a reset of an account's sync stream, before it's read whole again: forgets its assets, which are learned
   * again with their paths, and marks its albums stale until the stream sends them again (`sweep`).
   */
  forgetAccount(account: string): void {
    this.db.transaction(() => {
      this.db.query("delete from assets where account = ?").run(account);
      this.db.query("update albums set stale = 1 where account = ?").run(account);
      this.db.query("update album_assets set stale = 1 where account = ?").run(account);
      this.db.query("update people set stale = 1 where account = ?").run(account);
      this.db.query("update faces set stale = 1").run();
      this.db.query("insert into kv (key, value) values (?, '1') on conflict (key) do update set value = excluded.value").run(sweepKey(account));
    })();
  }

  /**
   * Once an account's stream has been read whole after a reset: forgets what it didn't send again, since that's gone.
   * Returns the assets whose albums or faces changed, or undefined when there was no reset to finish.
   */
  sweep(account: string): string[] | undefined {
    if (!this.db.query("select 1 from kv where key = ?").get(sweepKey(account))) return undefined;
    return this.db.transaction(() => {
      const assets = this.db
        .query<{ asset: string }, [string, string]>(
          `select asset from album_assets where account = ? and stale = 1
           union select asset from album_assets where album in (select id from albums where account = ? and stale = 1)`,
        )
        .all(account, account)
        .map((row) => row.asset);
      this.db.query("delete from album_assets where account = ? and stale = 1").run(account);
      this.db.query("delete from album_assets where account = ? and album in (select id from albums where account = ? and stale = 1)").run(account, account);
      this.db.query("delete from albums where account = ? and stale = 1").run(account);
      assets.push(
        ...this.db
          .query<{ asset: string }, [string]>(
            `select asset from faces where stale = 1
             union select asset from faces where person in (select id from people where account = ? and stale = 1)`,
          )
          .all(account)
          .map((row) => row.asset),
      );
      this.db.query("delete from faces where stale = 1").run();
      this.db.query("delete from people where account = ? and stale = 1").run(account);
      this.db.query("delete from kv where key = ?").run(sweepKey(account));
      return [...new Set(assets)];
    })();
  }

  // Albums (F9).

  /** Adds or renames an account's albums. Returns the IDs of those whose name changed (not the new ones). */
  putAlbums(account: string, albums: readonly AlbumRef[]): string[] {
    const current = this.db.query<{ name: string }, [string, string]>("select name from albums where account = ? and id = ?");
    const insert = this.db.query(
      `insert into albums (account, id, name, stale) values (?, ?, ?, 0)
       on conflict (account, id) do update set name = excluded.name, stale = 0`,
    );
    return this.db.transaction(() => {
      const renamed: string[] = [];
      for (const album of albums) {
        const before = current.get(account, album.id);
        if (before && before.name !== album.name) renamed.push(album.id);
        insert.run(account, album.id, album.name);
      }
      return renamed;
    })();
  }

  /** The account no longer sees these albums: they were deleted, or it lost access. Returns the assets they held. */
  removeAlbums(account: string, ids: readonly string[]): string[] {
    const members = this.db.query<{ asset: string }, [string, string]>("select asset from album_assets where account = ? and album = ?");
    const unalbum = this.db.query("delete from album_assets where account = ? and album = ?");
    const remove = this.db.query("delete from albums where account = ? and id = ?");
    return this.db.transaction(() => {
      const assets = new Set<string>();
      for (const id of ids) {
        for (const row of members.all(account, id)) assets.add(row.asset);
        unalbum.run(account, id);
        remove.run(account, id);
      }
      return [...assets];
    })();
  }

  /** Records assets in albums, as an account's stream reports them. */
  addToAlbums(account: string, entries: readonly { album: string; asset: string }[]): void {
    const insert = this.db.query(
      `insert into album_assets (account, album, asset, stale) values (?, ?, ?, 0)
       on conflict (account, album, asset) do update set stale = 0`,
    );
    this.db.transaction(() => {
      for (const { album, asset } of entries) insert.run(account, album, asset);
    })();
  }

  removeFromAlbums(account: string, entries: readonly { album: string; asset: string }[]): void {
    const remove = this.db.query("delete from album_assets where account = ? and album = ? and asset = ?");
    this.db.transaction(() => {
      for (const { album, asset } of entries) remove.run(account, album, asset);
    })();
  }

  /** The assets in an album, as any account sees it. */
  albumAssets(album: string): string[] {
    return this.db.query<{ asset: string }, [string]>("select distinct asset from album_assets where album = ? order by asset").all(album).map((row) => row.asset);
  }

  /** The albums holding an asset, as any account sees them, with a name an account knows them by. */
  albumsOf(asset: string): AlbumRef[] {
    return this.db
      .query<AlbumRef, [string]>(
        `select album_assets.album as id, min(albums.name) as name from album_assets
         join albums on albums.id = album_assets.album and albums.account = album_assets.account
         where album_assets.asset = ? group by album_assets.album order by album_assets.album`,
      )
      .all(asset);
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

  // Faces and people (F10).

  /** Adds or replaces faces. */
  putFaces(faces: readonly FaceRecord[]): void {
    const insert = this.db.query(
      `insert into faces (id, asset, person, x1, y1, x2, y2, width, height, source, visible, deleted, stale)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       on conflict (id) do update set asset = excluded.asset, person = excluded.person, x1 = excluded.x1,
         y1 = excluded.y1, x2 = excluded.x2, y2 = excluded.y2, width = excluded.width, height = excluded.height,
         source = excluded.source, visible = excluded.visible, deleted = excluded.deleted, stale = 0`,
    );
    this.db.transaction(() => {
      for (const face of faces) {
        insert.run(
          face.id,
          face.asset,
          face.person,
          face.boundingBoxX1,
          face.boundingBoxY1,
          face.boundingBoxX2,
          face.boundingBoxY2,
          face.imageWidth,
          face.imageHeight,
          face.source,
          face.visible ? 1 : 0,
          face.deleted,
        );
      }
    })();
  }

  /** Forgets faces Immich deleted for good. Returns the assets they were on. */
  removeFaces(ids: readonly string[]): string[] {
    const find = this.db.query<{ asset: string }, [string]>("select asset from faces where id = ?");
    const remove = this.db.query("delete from faces where id = ?");
    return this.db.transaction(() => {
      const assets = new Set<string>();
      for (const id of ids) {
        const row = find.get(id);
        if (row) assets.add(row.asset);
        remove.run(id);
      }
      return [...assets];
    })();
  }

  /** The faces on an asset, deleted ones included, in a stable order. */
  facesOn(asset: string): FaceRecord[] {
    return this.db.query<FaceRow, [string]>("select * from faces where asset = ? order by id").all(asset).map(toFace);
  }

  /** The assets with a face of this person. */
  assetsWithPerson(person: string): string[] {
    return this.db.query<{ asset: string }, [string]>("select distinct asset from faces where person = ? order by asset").all(person).map((row) => row.asset);
  }

  /**
   * Adds or replaces an account's records of people. Returns the IDs of those that are new, or whose name or hidden
   * changed: their faces' sidecars change.
   */
  putPeople(people: readonly PersonRecord[]): string[] {
    const current = this.db.query<{ name: string; hidden: number }, [string, string]>("select name, hidden from people where account = ? and id = ?");
    const insert = this.db.query(
      `insert into people (account, id, name, hidden, stale) values (?, ?, ?, ?, 0)
       on conflict (account, id) do update set name = excluded.name, hidden = excluded.hidden, stale = 0`,
    );
    return this.db.transaction(() => {
      const changed: string[] = [];
      for (const person of people) {
        const before = current.get(person.account, person.id);
        if (!before || before.name !== person.name || (before.hidden === 1) !== person.hidden) changed.push(person.id);
        insert.run(person.account, person.id, person.name, person.hidden ? 1 : 0);
      }
      return changed;
    })();
  }

  removePerson(account: string, id: string): void {
    this.db.query("delete from people where account = ? and id = ?").run(account, id);
  }

  /** An account's own record of a person. */
  person(account: string, id: string): PersonRecord | undefined {
    const row = this.db.query<{ name: string; hidden: number }, [string, string]>("select name, hidden from people where account = ? and id = ?").get(account, id);
    return row ? { account, id, name: row.name, hidden: row.hidden === 1 } : undefined;
  }
}
