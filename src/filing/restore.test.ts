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
