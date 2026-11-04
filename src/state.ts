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
