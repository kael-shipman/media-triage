import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config.ts";
import { type ImmichClient, ImmichError } from "../immich/client.ts";
import type { Exiftool } from "../sidecars/exiftool.ts";
import { State } from "../state.ts";
import type { ReconcileContext, Refreshing } from "../sync/reconcile.ts";
import { SyncStore } from "../sync/store.ts";
import type { OpenAccount } from "../upkeep/accounts.ts";
import { restorePending } from "./restore.ts";
import { FilingStore } from "./store.ts";

let dir: string;
let state: State;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  state = State.open(join(dir, "state"));
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a unit Immich fails on stays pending, to be tried again, and the others go on", async () => {
  const config = parseConfig(
    { paths: { inbox: join(dir, "Inbox"), archive: dir, state: join(dir, "state") }, immich: { path_map: [{ immich: "/mnt/media/", local: `${dir}/` }] } },
    null,
  );
  // Every call fails, as Immich did for one new copy's faces: answering 500.
  const failing = {
    call: async (what: string) => {
      throw new ImmichError(`${what}: Immich answered 500: Failed to get faces`, 500);
    },
  } as unknown as ImmichClient;
  const alex = { account: { name: "alex" }, client: failing, userId: "u1", email: "alex@example.com", isAdmin: true, clusterGroupId: "g1" } as unknown as OpenAccount;
  const ctx: ReconcileContext = {
    config,
    store: new SyncStore(state.db),
    exiftool: {} as Exiftool,
    accounts: new Map([["alex", alex]]),
    dryRun: false,
    refreshing: new Map<string, Refreshing>(),
  };

  // The first unit's filed file is there, so putting it back asks Immich, which fails. The second's is gone, which
  // needs no Immich: it's done, with that problem.
  const filed = join(dir, "Pictures", "2021.06.15 - Lake day", "2021.06.15-10.20.30 - Alex Example.jpg");
  mkdirSync(join(dir, "Pictures", "2021.06.15 - Lake day"), { recursive: true });
  writeFileSync(filed, "a photo");
  const filings = new FilingStore(state.db);
  const plan = (unit: string, destination: string) => ({ unit, destination, moves: [{ from: unit, to: destination }], oldAssets: [{ account: "alex", id: `old-${unit}` }] });
  filings.plan([plan(join(dir, "Inbox", "Phone", "IMG_1.jpg"), filed), plan(join(dir, "Inbox", "Phone", "IMG_2.jpg"), join(dir, "Pictures", "gone.jpg"))]);
  for (const record of filings.withStatus("planned")) filings.setStatus(record.unit, "restoring");

  const report = await restorePending(ctx);
  expect(report.failed).toEqual([{ unit: join(dir, "Inbox", "Phone", "IMG_1.jpg"), error: expect.stringContaining("Immich answered 500") }]);
  expect(report.done).toEqual([{ unit: join(dir, "Inbox", "Phone", "IMG_2.jpg"), problems: ["the filed file is gone, so nothing was put back"] }]);
  expect(filings.get(join(dir, "Inbox", "Phone", "IMG_1.jpg"))?.status).toBe("restoring");
  expect(filings.get(join(dir, "Inbox", "Phone", "IMG_2.jpg"))?.status).toBe("done");
});

/**
 * A copy filed to `filed`, its new copy found at the new path, and Immich answering 500 for its faces (as for a copy
 * whose metadata it hasn't read yet). `busy` says whether Immich's queues have work.
 */
function waitingOnFaces(minutesAgo: number, busy: boolean) {
  const config = parseConfig({ paths: { archive: dir, state: join(dir, "state") }, immich: { path_map: [{ immich: "/mnt/media/", local: `${dir}/` }] } }, null);
  const client = {
    call: async (what: string) => {
      if (what.startsWith("Reading the faces")) throw new ImmichError(`${what}: Immich answered 500: Failed to get faces`, 500);
      if (what.startsWith("Reading the ")) return { statistics: { active: busy ? 1 : 0, waiting: 0, delayed: 0 } };
      if (what === "Searching assets") return { assets: { items: [{ id: "new-1", ownerId: "u1" }], nextCursor: null } };
      if (what.startsWith("Reading asset")) return { id: "old-1", isOffline: true };
      throw new Error(`unexpected call: ${what}`);
    },
  } as unknown as ImmichClient;
  const alex = { account: { name: "alex" }, client, userId: "u1", email: "alex@example.com", isAdmin: true, clusterGroupId: "g1" } as unknown as OpenAccount;
  const ctx: ReconcileContext = { config, store: new SyncStore(state.db), exiftool: {} as Exiftool, accounts: new Map([["alex", alex]]), dryRun: false, refreshing: new Map<string, Refreshing>() };
  const unit = join(dir, "Inbox", "Phone", "IMG_1.jpg");
  const filed = join(dir, "Pictures", "2021.06.15 - Lake day", "2021.06.15-10.20.30 - Alex Example.jpg");
  mkdirSync(join(dir, "Pictures", "2021.06.15 - Lake day"), { recursive: true });
  writeFileSync(filed, "a photo");
  const filings = new FilingStore(state.db);
  filings.plan([{ unit, destination: filed, moves: [{ from: unit, to: filed }], oldAssets: [{ account: "alex", id: "old-1" }] }]);
  filings.setStatus(unit, "restoring");
  state.db.query("update filings set updated = ? where unit = ?").run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), unit);
  return { ctx, filings, unit };
}

test("Immich's 500 for a new copy's faces is waited for, not an error", async () => {
  const { ctx, filings, unit } = waitingOnFaces(5, false);
  const report = await restorePending(ctx);
  expect(report.failed).toEqual([]);
  expect(report.waiting).toEqual([{ unit, why: "Immich can't list the faces at the new path in alex yet (it hasn't read the copy's metadata)" }]);
  expect(filings.get(unit)?.status).toBe("restoring");
});

test("past the limit it's waited for while Immich is busy, and reported once Immich is idle", async () => {
  const busy = waitingOnFaces(120, true);
  expect((await restorePending(busy.ctx)).waiting.map((entry) => entry.unit)).toEqual([busy.unit]);
  state.db.query("delete from filings").run();

  const idle = waitingOnFaces(120, false);
  const report = await restorePending(idle.ctx);
  expect(report.done).toEqual([{ unit: idle.unit, problems: [expect.stringContaining("alex: the faces weren't put back: Immich couldn't list them")] }]);
  expect(idle.filings.get(idle.unit)?.status).toBe("done");
});

test("past the hard limit it's reported even while Immich is busy", async () => {
  const { ctx, unit } = waitingOnFaces(25 * 60, true);
  expect((await restorePending(ctx)).done.map((entry) => entry.unit)).toEqual([unit]);
});
