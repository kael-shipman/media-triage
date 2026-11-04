import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "./state.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("creates its folder privately, and keeps values between openings", () => {
  dir = join(mkdtempSync(join(tmpdir(), "media-triage-")), "state");
  const state = State.open(dir);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(state.get("missing")).toBeUndefined();
  state.set("a", "1");
  state.set("a", "2");
  state.close();

  const again = State.open(dir);
  expect(again.get("a")).toBe("2");
  again.close();
});

test("refuses a database from a newer version", () => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  const db = new Database(join(dir, "state.sqlite"));
  db.exec("pragma user_version = 999");
  db.close();
  expect(() => State.open(dir)).toThrow("written by a newer media-triage");
});
