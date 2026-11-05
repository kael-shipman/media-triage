import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The schema, one migration per entry. Never edit a released entry: add a new one. The database's `user_version`
 * is the number of migrations applied.
 */
const MIGRATIONS: readonly string[] = [
  // 1: small values kept between runs, such as the last upgrade check.
  `create table kv (key text primary key, value text not null) strict`,
  // 2: sync (src/sync/store.ts): every Immich asset the daemon knows, since the sync stream carries no paths, and
  // each unit's last-synced values, with its sidecar's stamp.
  `create table assets (
    id text primary key,
    account text not null,
    owner text not null,
    library text,
    path text not null,
    local text,
    trashed integer not null default 0,
    visibility text not null default 'timeline'
  ) strict;
  create index assets_local on assets (local);
  create index assets_account on assets (account);
  create table units (
    path text primary key,
    sidecar_size integer,
    sidecar_mtime real,
    sidecar_ino integer,
    synced text not null,
    updated text not null
  ) strict`,
  // 3: per-account state (F9): each asset's favorite, and the albums each account's stream reports, with their
  // assets. `stale` marks what a reset of the account's stream hasn't sent again yet; what's still stale once the
  // stream has been read whole is gone.
  `alter table assets add column favorite integer not null default 0;
  create table albums (
    account text not null,
    id text not null,
    name text not null,
    stale integer not null default 0,
    primary key (account, id)
  ) strict;
  create table album_assets (
    account text not null,
    album text not null,
    asset text not null,
    stale integer not null default 0,
    primary key (account, album, asset)
  ) strict;
  create index album_assets_asset on album_assets (asset);
  create index album_assets_album on album_assets (album)`,
  // 4: named faces (F10): every face on every asset in the accounts' cluster group, with its person (the person
  // group's ID) and box, and each account's own record of each person, with its name. Stale as in 3.
  `create table faces (
    id text primary key,
    asset text not null,
    person text,
    x1 real not null,
    y1 real not null,
    x2 real not null,
    y2 real not null,
    width integer not null,
    height integer not null,
    source text not null,
    visible integer not null,
    deleted text,
    stale integer not null default 0
  ) strict;
  create index faces_asset on faces (asset);
  create index faces_person on faces (person);
  create table people (
    account text not null,
    id text not null,
    name text not null,
    hidden integer not null,
    stale integer not null default 0,
    primary key (account, id)
  ) strict`,
  // 5: orphan sidecars (F11): when the daemon saw a unit's media file gone, so its sidecar can be deleted once the
  // grace period is over.
  `alter table units add column gone text`,
  // 6: filing (section 7, src/filing/): each unit filed or being filed, with its moves, planned before any of them is
  // made, so an interrupted batch can be finished; the old copies; and how far it got.
  `create table filings (
    unit text primary key,
    destination text not null,
    moves text not null,
    old_assets text not null,
    status text not null,
    created text not null,
    updated text not null,
    problem text
  ) strict;
  create index filings_destination on filings (destination);
  create index filings_status on filings (status)`,
];

/** The daemon's SQLite database, in the state folder. */
export class State {
  private constructor(readonly db: Database) {}

  static open(dir: string): State {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = new Database(join(dir, "state.sqlite"), { create: true, strict: true });
    db.exec("pragma journal_mode = wal");
    db.exec("pragma foreign_keys = on");
    db.exec("pragma busy_timeout = 5000");
    migrate(db);
    return new State(db);
  }

  get(key: string): string | undefined {
    const row = this.db.query<{ value: string }, [string]>("select value from kv where key = ?").get(key);
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .query("insert into kv (key, value) values (?, ?) on conflict (key) do update set value = excluded.value")
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

function migrate(db: Database): void {
  const { user_version: applied } = db.query<{ user_version: number }, []>("pragma user_version").get()!;
  if (applied > MIGRATIONS.length) {
    throw new Error(
      `The state database was written by a newer media-triage (schema ${applied}, this one knows ${MIGRATIONS.length}). ` +
        "Upgrade, or use another state folder.",
    );
  }
  for (let version = applied; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`pragma user_version = ${version + 1}`);
    })();
  }
}
