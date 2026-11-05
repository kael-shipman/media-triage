import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../state.ts";
import { SyncStore } from "../sync/store.ts";
import { FilingStore } from "./store.ts";

let dir: string;
let state: State;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  state = State.open(dir);
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

test("filings: planned, then restoring (which sync holds), then done; a plan forgotten", () => {
  const filings = new FilingStore(state.db);
  const sync = new SyncStore(state.db);
  const moves = [{ from: "/in/a.jpg", to: "/out/a.jpg" }];
  filings.plan([{ unit: "/in/a.jpg", destination: "/out/a.jpg", moves, oldAssets: [{ account: "alex", id: "a1" }] }]);
  expect(filings.get("/in/a.jpg")).toMatchObject({ status: "planned", moves, oldAssets: [{ account: "alex", id: "a1" }] });
  expect(filings.withStatus("planned").map((record) => record.unit)).toEqual(["/in/a.jpg"]);
  expect(sync.isBeingPutBack("/out/a.jpg")).toBe(false);

  filings.setStatus("/in/a.jpg", "restoring");
  expect(sync.isBeingPutBack("/out/a.jpg")).toBe(true);
  filings.setStatus("/in/a.jpg", "done", "a face couldn't be matched");
  expect(filings.get("/in/a.jpg")).toMatchObject({ status: "done", problem: "a face couldn't be matched" });
  expect(sync.isBeingPutBack("/out/a.jpg")).toBe(false);

  filings.forget("/in/a.jpg");
  expect(filings.get("/in/a.jpg")).toBeUndefined();
});
