import { expect, test } from "bun:test";
import type { Library } from "../config.ts";
import { datedExclusions } from "./exclusions.ts";
import { type ExistingLibrary, HIDDEN_EXCLUSIONS, IMMICH_DEFAULT_EXCLUSIONS, exclusionsFor, planLibraries, wantedLibrary } from "./libraries.ts";

const archive: Library = { account: "alex", name: "Archive", folders: ["/mnt/media/Pictures", "/mnt/media/Videos"], exclude: [] };
const shared: Library = {
  account: "sam",
  name: "Shared archive",
  folders: ["/mnt/media/Pictures", "/mnt/media/Videos"],
  exclude: ["/mnt/media/Pictures/Staging{,/**}"],
  dated: { since: "2020-06-15", levels: ["/mnt/media/Pictures", "/mnt/media/Videos/*"] },
};

test("a library excludes Immich's defaults, hidden files, its own patterns and its date limit's, once each", () => {
  expect(exclusionsFor(archive)).toEqual([...IMMICH_DEFAULT_EXCLUSIONS, ...HIDDEN_EXCLUSIONS]);
  const patterns = exclusionsFor(shared);
  expect(patterns.slice(0, 9)).toEqual([...IMMICH_DEFAULT_EXCLUSIONS, ...HIDDEN_EXCLUSIONS, "/mnt/media/Pictures/Staging{,/**}"]);
  expect(patterns.slice(9)).toEqual(datedExclusions(shared.dated!));
  expect(new Set(patterns).size).toBe(patterns.length);
  expect(patterns.length).toBeLessThanOrEqual(128);
});

const existing = (overrides: Partial<ExistingLibrary>): ExistingLibrary => ({
  id: "lib-1",
  ownerId: "u-alex",
  name: "Archive",
  importPaths: ["/mnt/media/Pictures", "/mnt/media/Videos"],
  exclusionPatterns: exclusionsFor(archive),
  ...overrides,
});

test("missing libraries are created, matching ones left alone, whatever the order of their lists", () => {
  const wanted = [wantedLibrary(archive, "u-alex"), wantedLibrary(shared, "u-sam")];
  const same = existing({ importPaths: ["/mnt/media/Videos", "/mnt/media/Pictures"], exclusionPatterns: [...exclusionsFor(archive)].reverse() });
  const plan = planLibraries(wanted, [same]);
  expect(plan.actions.map((action) => [action.kind, action.wanted.name])).toEqual([
    ["unchanged", "Archive"],
    ["create", "Shared archive"],
  ]);
  expect(plan.unknown).toEqual([]);
  expect(plan.problems).toEqual([]);
});

test("only what differs is changed", () => {
  const wanted = wantedLibrary(archive, "u-alex");
  const plan = planLibraries([wanted], [existing({ exclusionPatterns: ["**/@eaDir/**"] })]);
  expect(plan.actions).toEqual([{ kind: "update", wanted, existing: existing({ exclusionPatterns: ["**/@eaDir/**"] }), changes: { exclusionPatterns: wanted.exclusionPatterns } }]);
  const moved = planLibraries([wanted], [existing({ importPaths: ["/mnt/media/Pictures"] })]).actions[0];
  expect(moved).toMatchObject({ kind: "update" });
  expect(moved?.kind === "update" ? moved.changes : undefined).toEqual({ importPaths: wanted.importPaths });
});

test("libraries are matched by owner and name; the rest are reported, and duplicates are a problem", () => {
  const wanted = wantedLibrary(archive, "u-alex");
  const theirs = existing({ id: "lib-2", ownerId: "u-sam" });
  const other = existing({ id: "lib-3", name: "Old" });
  const plan = planLibraries([wanted], [theirs, other]);
  expect(plan.actions.map((action) => action.kind)).toEqual(["create"]);
  expect(plan.unknown.map((library) => library.id)).toEqual(["lib-2", "lib-3"]);

  const twice = planLibraries([wanted], [existing({ id: "a" }), existing({ id: "b" })]);
  expect(twice.actions).toEqual([]);
  expect(twice.unknown).toEqual([]);
  expect(twice.problems[0]!.problem).toContain('2 libraries named "Archive"');
});

test("too many exclusion patterns is a problem, before anything is sent", () => {
  const big = { ...wantedLibrary(archive, "u-alex"), exclusionPatterns: Array.from({ length: 129 }, (_, index) => `/x/${index}`) };
  expect(planLibraries([big], []).problems).toEqual([{ library: big, problem: "129 exclusion patterns, but Immich allows at most 128" }]);
});
