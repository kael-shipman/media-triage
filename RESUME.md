# Resume here

The handoff for whoever works on media-triage next, person or agent. Start with the [README](README.md) (what it's
for) and [docs/DESIGN.md](docs/DESIGN.md) (how it works, and why). DESIGN.md is the source of truth: if something
you're about to build would change it, ask the author first.

**Update this file after every completed step,** not just at the end of a session, so work can be picked up if a
session stops partway. Each step ends with tests passing, the type check clean, a commit and a push; CI must stay
green.

**Last updated:** 2026-11-04. Milestones 1–6 of 8 are done. **Milestone 7** (F9–F11) is under way: F9, a race fix and
F10 are done; **next is step 4, F11**, below.

## Working on it

- **Bun 1.4** runs and builds it. Without Bun installed, `npx --yes bun@1.4.4` stands in for `bun`:
  - `bun test`: the unit tests (364; 362 in CI, which skips the two that need Darktable), and the integration tests,
    skipped;
  - `bun run typecheck`: TypeScript, over `src/`, `scripts/` and `test/`;
  - `bun run build [version]`: executables for linux-x64 and linux-arm64 in `dist/` (`TARGETS=linux-x64` for one).
- **The development Immich** (`test/immich/`): upstream's 3.3.5 stack in Docker Compose, without machine learning, on
  `127.0.0.1:2284`, with made-up users (`alex@example.com`, the admin, and `sam@example.com`).
  - `bun run immich up` starts it (about a minute) and `bun run immich down` deletes everything. Leave it down when
    you stop: its database is in memory anyway.
  - `MEDIA_TRIAGE_IMMICH_TESTS=1 bun test` runs everything against it (411 tests). Run it twice in a row on one
    instance before calling a step done: tests must not depend on what other tests left behind.
  - Shared test helpers are in `test/immich/harness.ts`: `describeImmich`, `mediaFolder`, `photos`,
    `indexedLibrary`, `newUser` (fresh users, for anything that changes an account for good, such as joining a
    cluster group), `configFor`, `api`, `waitFor`.
- **exiftool:** the tests use the one on the PATH, or else the copy `exiftool-vendored` brings (this machine has no
  system exiftool). CI installs Ubuntu's (12.76) and checks that the executable uses it.
- **Darktable** (5.6.1 here, not in CI): `test/darktable.ts` runs it headless under `xvfb-run` on a copy, with a
  throwaway library, configuration, cache and home folder, and a Lua snippet (`image` is the imported photo). About
  3 seconds a run. Tests that need it are skipped without it.
- **Fixtures:** `test/fixtures/darktable.xmp` and `immich.xmp` were written by the tools themselves, from `photo.jpg`
  with made-up values: `bun test/fixtures/make.ts darktable|immich` makes them again (`immich` needs the development
  Immich).
- **Immich's source**, for checking behavior: the fork's clone at `~/Desktop/tmp-repos/immich`, branch `twins`, based
  on v3.3.5. Look in `server/src`: `controllers/`, `dtos/`, `services/`, `repositories/`. Use Immich only through
  its API, never its database.
- **Releases:** `v0.1.0-rc.1` and `rc.2` exist, from milestone 1 only. Don't tag a release without the author.

## Where things stand

| What | Where | Milestone |
|---|---|---|
| Command line: `help`, `version`, `init`, `config`, `run`, `login`, `check`, `sidecar`, `upgrade` | `src/cli.ts` | 1, 3, 4, 5 |
| Configuration (TOML, every setting checked), state database (numbered migrations), scheduler (one job at a time; a run can ask to run again sooner), logging | `src/config.ts`, `state.ts`, `scheduler.ts`, `log.ts` | 1 |
| Self-upgrade, installer, CI and releases, checked end to end with two pre-releases | `src/upgrade.ts`, `install.sh`, `.github/workflows/` | 1 |
| The pure rules: tags (F4), titles (F3), filing names (section 7), date limits and their exclusion patterns, path classification, orphans (F11), the path map, the library plan, Immich's extensions | `src/core/` | 2, 3, 4 |
| The Immich client: sessions and `login`, the sync stream, assets, albums, faces, people, libraries, cluster groups | `src/immich/` | 3 |
| Account upkeep, at start and every full pass: accounts, the cluster group, libraries, the check, people | `src/upkeep/` | 4 |
| A sidecar's fields, what Immich and Darktable each read from them, and planning writes (F2–F10); face regions from Immich's faces | `src/core/xmp.ts`, `regions.ts` | 5 |
| exiftool (one process, the system's in a release), the namespace's config, reading, writing and creating sidecars | `src/sidecars/` | 5 |
| The merge (`mergeUnit`) | `src/core/merge.ts` | 6 |
| Sync: state (`SyncStore`), covered folders, the watcher, the full pass, each account's stream, the reconcile, the daemon's jobs | `src/sync/` | 6 |
| Per-account state (F9): favorites, visibility and albums, from each copy and the stream's albums | `src/sync/reconcile.ts` (`accountStates`), `store.ts`, `stream.ts` | 7 |
| Named faces (F10): faces and people from the streams, `People/<name>` tags and regions | `src/core/faces.ts`, `src/sync/reconcile.ts` (`namedFaces`), `store.ts`, `stream.ts` | 7 |

**The daemon's jobs:** account upkeep and the check, the full pass and sync (F1–F10 without F5), and the upgrade check.
Nothing files yet, and orphan sidecars aren't handled yet.

**Found in Immich 3.3.5 while building milestones 3 and 4** (each is in DESIGN.md, and each has a test):
- the sync stream refuses `AssetsV1` (use `AssetsV2`), carries no paths, and `AssetFacesV3` covers the whole cluster
  group;
- searches leave out locked assets, and a locked asset reads like a missing one without the account's PIN;
- a library file that goes offline is also marked trashed, and coming back clears both;
- `refresh-metadata` never reads a sidecar that appeared after Immich indexed the file;
- the face reassign call is `PUT /faces/{person}` with the face's ID in the body;
- a person's API ID is its person group's, the same in every account of a cluster group; renames reach the records
  shared with write access; `GET /people` hides unnamed people with fewer than 3 faces;
- two accounts' libraries can index the same folder; joining a cluster group keeps an account's named people.

**Found while building milestone 5** (also in DESIGN.md, each with a test):
- Immich writes the description and date twice (`tiff:ImageDescription`, `photoshop:DateCreated`) and reads its own
  copies first, so Darktable's edits don't reach it unless the daemon updates those copies (F6);
- Darktable has no time zones by design (it drops offsets, and never reads `OffsetTimeOriginal`), so dates compare by
  wall time, and `photoshop:DateCreated`, which Darktable keeps, holds the capture time with its zone (F6, below);
- Immich shows Darktable's own tags (`darktable/format/jpg`) when a sidecar has no `TagsList` (F4);
- Immich and Darktable both keep the daemon's namespace and face regions when they rewrite a sidecar (F9, F10);
- a region's coordinates are in the stored image, and Immich rotates them by the orientation (F10);
- exiftool 12.76 can't quote numbers in its JSON, so the reader keeps each number's text ("1.50" stays "1.50");
- in a compiled executable, `exiftool-vendored` would still find its own copy by the build machine's path: a release
  must use only the exiftool on the PATH.

## Decided by the author, 2026-11-04

These shape milestone 6; DESIGN.md has each.
- **Capture times: both tools always show the same one, and get the zoned one** (F6). Built in `planWrite` (a time
  changed in Darktable is written to both date fields with the zone it had; an offset Darktable merely dropped isn't
  rewritten), and checked with Darktable itself. Milestone 6's reconcile passes Darktable's date
  (`darktableReads(...).date`) or the merged one as `date`, and `offset: offsetFromImmich(asset)` when it has a copy.
- **F5, rejects Immich resets: not handled.** The author triages in one tool at a time and deletes the photos
  rejected in Darktable right after triaging; Immich doesn't rewrite sidecars in the background meanwhile. So nothing
  puts a `-1` back, and `x:xmptk` is only read for `media-triage sidecar`.
- **F1, sidecars Immich never reads:** fixed in the author's Immich fork, not worked around here. The fork's
  `refresh-metadata` will look for a sidecar first. That patch belongs to the fork's track and **isn't written yet**
  (the project's task 0058); it's needed before sync goes live, not to build it. Milestone 6 adds a setting, like
  `mirrors_face_corrections`, saying whether the server has the fix.
- **F8, offline isn't trash:** a trash or restore is mirrored only after reading through the API (`getAsset`,
  `isOffline`) that the copy it happened to isn't offline. Going offline and coming back online are never mirrored.
- **The covered folders:** the daemon watches and passes over every configured library's folders (mapped to local
  paths) plus the inbox's sources, not everything under `paths.archive`, which is only where filing puts files.
- **The check moves out of upkeep** when sync is built (milestone 6, step 1 below).

## Next: milestone 7, F9–F11

DESIGN.md section 6. The reconcile (`src/sync/reconcile.ts`) is where each goes. The stream acknowledges people and
faces' events without acting on them yet (`src/sync/stream.ts`, `assetOf`).
1. [x] **F9, per-account state** (done 2026-11-04): migration 3 (`assets.favorite`; `albums` and `album_assets`, per
   account, since an `AlbumDeleteV1` means the account lost the album); the stream records them and reconciles every
   unit in an album that's renamed or lost (`recordAlbums`); the reconcile writes `wanted.accounts` from
   `accountStates` (a locked copy goes by the stream's record; an account with no copy to go by keeps its entry;
   `hidden` isn't recorded). A reset marks the account's albums stale instead of emptying them, and `sweep` drops
   what's still stale once the stream completes. Also fixed: assets are learned only from the account's own asset
   events and only if it owns them (an album event could name another user's asset, which was then recorded under
   the wrong account). Tested end to end (`reconcile.test.ts`, F9).
2. [x] **A race in milestone 6, fixed** (2026-11-04): right after the daemon wrote a sidecar, the watcher's next
   reconcile read a copy that hadn't re-read it yet, and put back a tag just removed in Darktable (confirmed with the
   development Immich). Now a copy asked to refresh isn't a side for the sidecar's values until it catches up
   (`isCatchingUp` in `src/sync/reconcile.ts`, DESIGN.md section 5; `ReconcileContext.refreshing`, held by the `Sync`
   job). Test: "a tag removed in Darktable stays removed…" in `reconcile.test.ts`.
3. [x] **F10, named faces** (done 2026-11-04): migration 4 (`faces`, keyed by face ID, the whole cluster group's,
   with the person group's ID and box, `isVisible`, `deletedAt`; `people` per account: name, hidden; both stale and
   swept like albums); the stream records them (`recordAlbumsAndFaces`) and reconciles every unit with a face of a
   person renamed, hidden, shown or deleted; `applyFaces` (`src/core/faces.ts`) adds `People/<name>` tags (a `/` in a
   name as `|`) and, for photos, regions, from `namedFaces` (each person's faces from the first copy that has them).
   The unit's record keeps the tags and regions the daemon made (`SyncedValues.people`, `regions`): a tag already
   there is hand made and stays; other tools' regions stay. Tested end to end with a face added by hand, a rename and
   a deleted face (`reconcile.test.ts`, F10). Not covered: Immich's recognition (the development Immich has no machine
   learning).
4. **F11, orphan sidecars:** `src/core/orphans.ts` has the rules; the full pass sees media go. Seen, then gone for the
   grace period (1 h): delete; never seen: report; conflict copies: report.
5. **Not done in milestone 6, worth doing:** removing GPS or a date when a side drops one (now ignored, so nothing is
   lost); a test that the daemon's watcher-to-reconcile path works without the development Immich (the smoke test in
   step 7 below was by hand).

## Milestone 6, sync (done 2026-11-04)

DESIGN.md sections 3, 5 and 6 (F1–F8, without F5) and 13. Read "Decided by the author" above first.

What milestone 5 gives it (`src/sidecars/`, `src/core/xmp.ts`):
- `Exiftool.start()` once when the daemon starts, `close()` when it stops. A missing exiftool is an `ExiftoolMissing`
  with the install command: the daemon should stop with that message, not run without sidecars.
- `readSidecar` gives the fields and the file's stamp (size, mtime, inode). `writeSidecar(exiftool, sidecar, wanted)`
  writes only what changes, and returns `changed-meanwhile` without writing if the file changed since it was read
  (section 5, step 3), or the new stamp to record. `createSidecar` is F2's minimal sidecar.
- `immichReads` and `darktableReads` say what each tool sees in a sidecar (tags in Immich's notation, without
  Darktable's own): those are the sides the merge compares, with each copy's API values. `Wanted` is what the merge
  decides; the Immich copies of the description and date, and `TagsList`, follow by themselves.
- `sameDate` compares dates as both tools can show them; `offsetFromImmich` gives a copy's zone as an offset.
  `regionFromFace` needs the asset's `exifInfo.orientation`.

1. [x] **The check is its own job** (done 2026-11-04): upkeep starts scans and ends; the `check` job runs after each
   upkeep once Immich's library queue is idle twice in a row (`checkIfIdle`, `checkJob` in `src/upkeep/upkeep.ts`),
   looking again each minute while it's busy.
2. [x] **State** (done 2026-11-04): migration 2 in `src/state.ts`, used through `SyncStore` (`src/sync/store.ts`):
   `assets` (ID, account, owner, library, Immich's path, the local path, trashed, visibility; indexed by local path
   and account) and `units` (the media file's local path, its sidecar's stamp, and the last-synced values as JSON:
   `SyncedValues`). Not yet filled: the sync stream consumer (step 4) adds assets, looking up new ones' paths in bulk
   with `libraryPages` on a first run, after a reset, or when a batch has many new assets, and one by one with
   `getAsset` otherwise; the reconcile (step 5) writes units.
3. [x] **The watcher and the full pass** (done 2026-11-04), in `src/sync/`, not yet started by the daemon (step 5 does
   that, since the reconcile job is what consumes them):
   - `covered.ts`: `coveredFolders(config)` (libraries' folders through the path map, plus the inbox's sources; none
     inside another; unmapped ones reported), `unitOf(path)` (a change's unit: the media file, or the one a
     `<file>.<ext>.xmp` belongs to; hidden, temporary, conflict and other sidecars ignored), and `watchWarning`
     against `fs.inotify.max_user_watches` (warns past half, with the command to raise it).
   - `watcher.ts`: `Watcher` (Bun's recursive `fs.watch`: one inotify instance, new folders included, checked) and
     `DirtyUnits` (units taken once quiet for a moment, so a sidecar written in steps is acted on once).
   - `full-pass.ts`: `fullPass(store, folders)`: stats only; returns units with no record or whose sidecar's stamp
     changed.
4. [x] **The sync stream consumer** (done 2026-11-04), `src/sync/stream.ts`: `consumeStream(account, store, map,
   { act })` reads one account's stream to its end; per batch it records assets (`AssetV2`: trash and visibility;
   `AssetDeleteV1`: removed), learns new assets' paths (`learnAssets`: whole libraries past 50 unknown, else
   `getAsset` each), hands the batch's units (local media paths; asset, exif and album-membership events) to `act`,
   and only then acknowledges. On `SyncResetV1` it acknowledges, forgets the account's assets and returns
   `reset: true`: the caller reads again (`learnAllAssets` can fill the store first). People, faces and albums' own
   events are acknowledged and otherwise left for milestone 7. Not yet run by the daemon (step 5).
5. [x] **The reconcile loop** (done 2026-11-04). Done: the pure merge, `src/core/merge.ts` (`mergeUnit(base, title, sides)`;
   sides are Darktable's view of the sidecar and each copy through the API, each as `SideValues`; tags tag by tag
   with the title as `Title/…`; rating, description, date, GPS to the latest change; F8 trash from online copies;
   two titles are a conflict). `SyncedValues` (the base) gained `trashed`. Done: `src/sync/reconcile.ts`
   (`reconcile(ctx, units)`: reads the sidecar and each copy, merges, writes the sidecar's changed fields, refreshes
   every copy when the sidecar changed and any copy not in step with what it would read from it, mirrors trash from
   online copies, makes F2's minimal sidecar in inbox sources, records the unit; a dry run writes, records and
   acknowledges nothing), tested end to end with two accounts' copies (`reconcile.test.ts`). Done: the daemon's
   jobs (`src/sync/job.ts`, `Sync`): at start it starts exiftool (stopping the daemon with the install command if
   it's missing), the covered folders' watcher and the watch-allowance check; `full-pass` runs at start and daily;
   `sync` runs each minute and after every change the watcher sees: each account's stream (learning all its assets
   first when the store has none, and again after a reset), then up to 200 dirty units once quiet for 2 s. A dry run
   reads the streams once per start. Tests: 354 unit, 398 with the development Immich (twice in a row).
6. [x] **F1's setting** (done 2026-11-04): `immich.reads_new_sidecars` (default false); without it, the reconcile
   warns when it makes a sidecar Immich won't read. F8's offline check is in the merge and the reconcile (an offline
   copy is never a source of a trash, and never restored).
7. [x] **Smoke test** (2026-11-04): the daemon, run live against the development Immich with one account, created the
   library, learned the asset, wrote the title tag into the sidecar (it reached Immich), and a rating written to the
   sidecar on disk while it ran reached Immich through the watcher; SIGTERM stopped it cleanly. A unit can be refreshed
   twice in a row while Immich catches up (harmless).

Before anything runs against the author's real files: a dry run over everything, and the author's approval of the
first live write (DESIGN.md section 9).

## Gotchas

- **picomatch reads `[!…]` as a literal "!"**, not a negation: write negated brackets as `[^…]`.
- **`Bun.spawnSync` blocks the event loop.** A child process that calls a `Bun.serve` running in the same test
  process deadlocks. Use `Bun.spawn` and await it.
- **`pkill -f <pattern>` can match your own shell command** and kill it.
- **`expect(promise).rejects` must be awaited**, or a failure can go unnoticed.
- **Use `npx --yes bun@1.4.4`,** not a `bun` found in `~/.npm/_npx/`: there's an older one (1.1.24) there too, without
  `JSON.parse`'s source text, which the sidecar reader needs.
- **`exiftool-vendored` doesn't write booleans inside a structure:** write `"True"` (exiftool reads it as true).
- **exiftool reads `-config` only as its first argument;** `Exiftool.start` puts it there.
- **`npx` and `bun run` put `node_modules/.bin` on the PATH,** so the tests find the bundled exiftool there, as "on
  the PATH".
- **Paths in tests:** this repository is under a hidden folder on the author's machine, so anything that matches
  exclusion patterns must match Immich's paths, never local ones (the check's crawl does; see `src/upkeep/check.ts`).
- **Immich lowercases emails;** `newUser` makes lowercase ones.
- **The development Immich is shared by every test file:** other tests' libraries and people are there too. Filter
  by your own IDs, and use fresh users for anything that changes an account for good.
- **Flaky once, not reproduced** (2026-11-04): `stream.test.ts`, "a rating and a trash come through as their unit"
  (passed 6 times in a row after). If it recurs, print what `units` held. One possible cause, from Immich's source: a
  stream row's `updateId` is set when the row is updated (`updated_at` trigger), not when its transaction commits, so a
  row committed after a later one of the same type was acknowledged is never sent (`upsertQuery`). That would affect
  Immich's phone apps too.
- **mtime ticks:** the kernel updates mtimes at its clock's tick (a few ms), so a test that edits a sidecar in place,
  keeping its size, right after reading it can leave the stamp unchanged. Change the size.
- **Immich's background jobs run after API calls return** (thumbnails, a person's face): wait for them (`waitFor`)
  before asserting there's nothing new.

## Milestones

**1. Foundation**, done 2026-11-03
1. [x] Repository, README, design, RESUME.
2. [x] Command line, TOML configuration with validation, state database (`bun:sqlite`), logging.
3. [x] Upgrades (`upgrade`, and the daemon's scheduled check).
4. [x] The installer (`install.sh`).
5. [x] CI and releases; pre-releases to try the installer and an upgrade end to end.

**2. The pure rules** (`src/core/`), done 2026-11-03
1. [x] Tags (F4). 2. [x] Titles (F3). 3. [x] Filing names (section 7). 4. [x] Folder dates and exclusion patterns
(section 8). 5. [x] Orphan sidecars (F11).

**3. Immich client** (`src/immich/`), done 2026-11-04
1. [x] A development Immich for the integration tests (`test/immich/`).
2. [x] Login and sessions, the sync stream, and the asset, album, face, people, library and cluster-group calls.
3. [x] The path map (`src/core/path-map.ts`).

**4. Account upkeep** (section 8, `src/upkeep/`), done 2026-11-04
1. [x] The library plan and path classification (`src/core/`).
2. [x] Accounts and the cluster group.
3. [x] Libraries: create, correct, scan.
4. [x] `media-triage check`.
5. [x] People: shared both ways, names copied.
6. [x] The daemon's upkeep job.

**5. Sidecar I/O** (`src/sidecars/`, `src/core/xmp.ts`, `regions.ts`), done 2026-11-04
1. [x] exiftool: one process, the system's in a release, checked in CI with Ubuntu's.
2. [x] The fields, what each tool reads, and writes of only what changes, after checking the file again.
3. [x] Minimal sidecars (F2).
4. [x] The namespace (F9), kept by Immich and Darktable (checked).
5. [x] Face regions (F10).
6. [x] Fixtures, made by Darktable and Immich themselves.

**6. Sync** (`src/sync/`, `src/core/merge.ts`), done 2026-11-04: the check as its own job, state, the watcher and
full pass, the sync stream consumer, the reconcile loop, F1–F8 (F5 dropped), the daemon's jobs, a live smoke test.

**7. F9–F11:** Immich-only state, named faces, orphan sidecars.

**8. Filing:** section 7, with putting the per-account state back.

## Rules

- **No personal data in this repository:** it's public. No real names, emails, addresses, home paths, server names
  or real dates from the author's setup. Examples and tests use made-up ones (Alex Example, Sam Example, 2020-06-15).
  Milestone 2 once held real ones; they were replaced on 2026-11-04 but remain in git history, which only the author
  may decide to rewrite.
- **Docs are part of done:** the README, DESIGN.md and this file stay current with the code.
- **Never test against a real archive first.** Use copies. Never delete or move real media.
- **The author's other systems are off limits** unless asked: their server, their `~/Setup` (no git, syncs to every
  machine including a public one, so it must never hold secrets), and the Immich fork's track, which waits on the
  author's review.
