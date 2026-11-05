import { expect, test } from "bun:test";
import { type CopyState, type ReadinessInput, readiness, withNeedsTitle } from "./filing.ts";

test("Promote without a title needs one; the daemon's tag goes once there's a title, or no Promote", () => {
  expect(withNeedsTitle(["Promote", "Places/Lake"], null)).toEqual(["Places/Lake", "Promote", "Promote/Needs a title"]);
  expect(withNeedsTitle(["Promote", "Promote/Needs a title"], "Lake day")).toEqual(["Promote"]);
  expect(withNeedsTitle(["Promote/Needs a title"], null)).toEqual([]);
  expect(withNeedsTitle(["Places/Lake"], null)).toEqual(["Places/Lake"]);
});

const now = Date.parse("2026-11-04T12:00:00.000Z");
const minutes = (count: number) => count * 60_000;
const copy = (changes: Partial<CopyState> = {}): CopyState => ({ trashed: false, inStep: true, catchingUp: false, changedAt: now - minutes(10), ...changes });
const ready: ReadinessInput = {
  tags: ["Promote", "Places/Lake"],
  title: "Lake day",
  rating: 3,
  copies: [copy(), copy()],
  unreadable: 0,
  sidecarChangedAt: now - minutes(6),
  settleMs: minutes(5),
  now,
};

test("ready: Promote, a title, nothing trashed or rejected, every copy in step, and quiet for the settle time", () => {
  expect(readiness(ready)).toEqual({ ready: true });
  expect(readiness({ ...ready, copies: [] })).toEqual({ ready: true });
});

test.each<[string, Partial<ReadinessInput>, string]>([
  ["no Promote", { tags: ["Places/Lake"] }, "it isn't tagged Promote"],
  ["no title", { title: null }, "it has no title"],
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
