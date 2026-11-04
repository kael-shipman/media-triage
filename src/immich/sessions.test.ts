import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionError, loadSession, removeSession, saveSession, sessionFile } from "./sessions.ts";

let state: string;
beforeEach(() => {
  state = join(mkdtempSync(join(tmpdir(), "media-triage-")), "state");
});
afterEach(() => rmSync(join(state, ".."), { recursive: true, force: true }));

const session = { token: "t0ken", userId: "u1", email: "alex@example.com", created: "2026-01-02T03:04:05.000Z" };

test("saves privately, replaces, and loads", () => {
  expect(loadSession(state, "alex")).toBeUndefined();
  saveSession(state, "alex", session);
  expect(statSync(join(state, "sessions")).mode & 0o777).toBe(0o700);
  expect(statSync(sessionFile(state, "alex")).mode & 0o777).toBe(0o600);
  expect(loadSession(state, "alex")).toEqual(session);

  saveSession(state, "alex", { ...session, token: "newer" });
  expect(loadSession(state, "alex")?.token).toBe("newer");
  expect(readdirSync(join(state, "sessions"))).toEqual(["alex"]);

  removeSession(state, "alex");
  expect(loadSession(state, "alex")).toBeUndefined();
});

test("refuses a session file others can read", () => {
  saveSession(state, "alex", session);
  chmodSync(sessionFile(state, "alex"), 0o644);
  expect(() => loadSession(state, "alex")).toThrow(SessionError);
  expect(() => loadSession(state, "alex")).toThrow("chmod 600");
});

test("refuses a file that isn't a session", () => {
  saveSession(state, "alex", session);
  writeFileSync(sessionFile(state, "alex"), "not json", { mode: 0o600 });
  expect(() => loadSession(state, "alex")).toThrow("Log in again with `media-triage login alex`");
  writeFileSync(sessionFile(state, "alex"), '{"token": 1}', { mode: 0o600 });
  expect(() => loadSession(state, "alex")).toThrow("isn't a session file");
});
