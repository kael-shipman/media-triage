import { expect, test } from "bun:test";
import { type CopyState, type ReadinessInput, readiness, withInbox, withNeeds } from "./filing.ts";

test("Promote without a title or a creator needs one; the daemon's tags go once there's the value, or no Promote", () => {
  const both = { title: "Lake day", creator: "Alex Example" };
  expect(withNeeds(["Promote", "Places/Lake"], { ...both, title: null })).toEqual(["Places/Lake", "Promote", "Promote/Needs a title"]);
  expect(withNeeds(["Promote", "Places/Lake"], { ...both, creator: null })).toEqual(["Places/Lake", "Promote", "Promote/Needs a creator"]);
  expect(withNeeds(["Promote"], { title: null, creator: null })).toEqual(["Promote", "Promote/Needs a creator", "Promote/Needs a title"]);
  expect(withNeeds(["Promote", "Promote/Needs a creator", "Promote/Needs a title"], both)).toEqual(["Promote"]);
  expect(withNeeds(["Promote/Needs a creator", "Promote/Needs a title"], { title: null, creator: null })).toEqual([]);
  expect(withNeeds(["Places/Lake"], { title: null, creator: null })).toEqual(["Places/Lake"]);
});

test("an inbox unit is tagged Inbox, and nothing else is", () => {
  expect(withInbox(["Places/Lake", "Promote"], true)).toEqual(["Inbox", "Places/Lake", "Promote"]);
  expect(withInbox(["Inbox", "Places/Lake"], true)).toEqual(["Inbox", "Places/Lake"]);
  expect(withInbox(["Inbox", "Places/Lake"], false)).toEqual(["Places/Lake"]);
  expect(withInbox([], false)).toEqual([]);
});

const now = Date.parse("2026-11-04T12:00:00.000Z");
const minutes = (count: number) => count * 60_000;
const copy = (changes: Partial<CopyState> = {}): CopyState => ({ trashed: false, inStep: true, catchingUp: false, changedAt: now - minutes(10), ...changes });
const ready: ReadinessInput = {
  tags: ["Promote", "Places/Lake"],
  title: "Lake day",
  creator: "Alex Example",
  rating: 3,
  copies: [copy(), copy()],
  unreadable: 0,
  sidecarChangedAt: now - minutes(6),
  settleMs: minutes(5),
  now,
};

test("ready: Promote, a title and a creator, nothing trashed or rejected, every copy in step, and quiet for the settle time", () => {
  expect(readiness(ready)).toEqual({ ready: true });
  expect(readiness({ ...ready, copies: [] })).toEqual({ ready: true });
});

test.each<[string, Partial<ReadinessInput>, string]>([
  ["no Promote", { tags: ["Places/Lake"] }, "it isn't tagged Promote"],
  ["no title", { title: null }, "it has no title"],
  ["no creator", { creator: null }, "it has no creator"],
  ["rejected", { rating: -1 }, "it's rejected"],
  ["a copy trashed", { copies: [copy(), copy({ trashed: true })] }, "a copy is in the trash"],
  ["an account not open", { unreadable: 1 }, "a copy's account isn't open, so its state can't be read"],
  ["a copy out of step", { copies: [copy({ inStep: false })] }, "a copy hasn't read the sidecar yet"],
  ["a copy catching up", { copies: [copy({ catchingUp: true })] }, "a copy hasn't read the sidecar yet"],
])("not ready: %s", (_name, changes, why) => {
  expect(readiness({ ...ready, ...changes })).toEqual({ ready: false, why });
});

test("not settled: says how long until it is, from the latest change on any side", () => {
  expect(readiness({ ...ready, sidecarChangedAt: now - minutes(1) })).toEqual({ ready: false, why: "it changed less than the settle time ago", inMs: minutes(4) });
  expect(readiness({ ...ready, copies: [copy({ changedAt: now - minutes(3) })] })).toMatchObject({ inMs: minutes(2) });
});
