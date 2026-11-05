// What filing keeps (DESIGN.md, section 7), in the state database: each unit filed or being filed, by its old path.
// A unit's moves are recorded before any is made, so a batch cut short is finished on the next run.
//
// - planned: the moves are recorded, and may be partly made;
// - restoring: every file has moved, and the unit's per-account state and faces are being put back on its new copies
//   (sync holds the unit meanwhile: src/sync/reconcile.ts);
// - done: put back, or given up on with a problem. Kept as a record.

import type { Database } from "bun:sqlite";
import type { Move } from "./plan.ts";

export type FilingStatus = "planned" | "restoring" | "done";

export interface FilingRecord {
  /** The media file's old path. */
  unit: string;
  /** Its new path. */
  destination: string;
  moves: Move[];
  /** The copies at the old path: account and asset ID. */
  oldAssets: { account: string; id: string }[];
  status: FilingStatus;
  /** When it was planned, and last changed (ISO 8601). */
  created: string;
  updated: string;
  /** What went wrong, if something did. */
  problem?: string;
}

interface FilingRow {
  unit: string;
  destination: string;
  moves: string;
  old_assets: string;
  status: string;
  created: string;
  updated: string;
  problem: string | null;
}

const toRecord = (row: FilingRow): FilingRecord => ({
  unit: row.unit,
  destination: row.destination,
  moves: JSON.parse(row.moves) as Move[],
  oldAssets: JSON.parse(row.old_assets) as FilingRecord["oldAssets"],
  status: row.status as FilingStatus,
  created: row.created,
  updated: row.updated,
  ...(row.problem !== null ? { problem: row.problem } : {}),
});

export class FilingStore {
  constructor(private readonly db: Database) {}

  /** Records planned units, in one transaction, before any of their files moves. */
  plan(records: readonly Omit<FilingRecord, "status" | "created" | "updated">[]): void {
    const now = new Date().toISOString();
    const insert = this.db.query(
      `insert into filings (unit, destination, moves, old_assets, status, created, updated, problem) values (?, ?, ?, ?, 'planned', ?, ?, null)
       on conflict (unit) do update set destination = excluded.destination, moves = excluded.moves,
         old_assets = excluded.old_assets, status = 'planned', created = excluded.created, updated = excluded.updated, problem = null`,
    );
    this.db.transaction(() => {
      for (const record of records) insert.run(record.unit, record.destination, JSON.stringify(record.moves), JSON.stringify(record.oldAssets), now, now);
    })();
  }

  setStatus(unit: string, status: FilingStatus, problem?: string): void {
    this.db.query("update filings set status = ?, problem = ?, updated = ? where unit = ?").run(status, problem ?? null, new Date().toISOString(), unit);
  }

  get(unit: string): FilingRecord | undefined {
    const row = this.db.query<FilingRow, [string]>("select * from filings where unit = ?").get(unit);
    return row ? toRecord(row) : undefined;
  }

  withStatus(status: FilingStatus): FilingRecord[] {
    return this.db.query<FilingRow, [string]>("select * from filings where status = ? order by created, unit").all(status).map(toRecord);
  }

  /** Forgets a planned unit none of whose files moved, so it can be planned again. */
  forget(unit: string): void {
    this.db.query("delete from filings where unit = ?").run(unit);
  }
}
