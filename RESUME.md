# Resume here

The handoff for whoever works on media-triage next, person or agent. Start with the [README](README.md) (what it's
for) and [docs/DESIGN.md](docs/DESIGN.md) (how it works, and why). DESIGN.md is the source of truth: if something
you're about to build would change it, ask the author first.

**Update this file after every completed step,** not just at the end of a session, so work can be picked up if a
session stops partway. Each step ends with tests passing, the type check clean, a commit and a push; CI must stay
green.

**Last updated:** 2026-11-11 (`v0.2.0`: filing only in a daily window, "Filing at night" below). **All 8 milestones are done** (the last,
filing, on 2026-11-05), and the first run over a real archive was checked and four ways it could lose data were fixed
("Checked before the first real run", below). `v0.1.0` was installed on the author's server and dry-run over their
archive on 2026-11-07, which found two ways the first run would write wrong values, fixed in `v0.1.1` ("The first dry
run", below). `v0.1.1`'s dry run there was good, and **it's been live on the author's server since 2026-11-07**.
`v0.1.2` (2026-11-08, "After going live", below) and `v0.1.3` (2026-11-09) reach it by the daemon's own upgrade.

## Working on it

- **Bun 1.4** runs and builds it. Without Bun installed, `npx --yes bun@1.4.4` stands in for `bun`:
  - `bun test`: the unit tests (404; 402 in CI, which skips the two that need Darktable), and the integration tests,
    skipped;
  - `bun run typecheck`: TypeScript, over `src/`, `scripts/` and `test/`;
  - `bun run build [version]`: executables for linux-x64 and linux-arm64 in `dist/` (`TARGETS=linux-x64` for one).
- **The development Immich** (`test/immich/`): upstream's 3.3.5 stack in Docker Compose, without machine learning, on
  `127.0.0.1:2284`, with made-up users (`alex@example.com`, the admin, and `sam@example.com`).
  - `bun run immich up` starts it (about a minute) and `bun run immich down` deletes everything. Leave it down when
    you stop: its database is in memory anyway.
  - `MEDIA_TRIAGE_IMMICH_TESTS=1 bun test` runs everything against it (462 tests). Run it twice in a row on one
    instance before calling a step done: tests must not depend on what other tests left behind.
  - `bun test/immich/smoke.ts` is the daemon's smoke test (about 5 minutes): it runs `media-triage run` itself, with
    two fresh accounts, and checks that it files a batch end to end (the file's header says what it does). Run it
    after changing filing, sync or the daemon's jobs. It isn't part of `bun test`.
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
- **Releases:** `v0.2.0` (2026-11-11, filing at a set time), `v0.1.3` (2026-11-09, the refresh loop), `v0.1.2` (2026-11-08, duplicates filed, the watcher's names), `v0.1.1` (2026-11-07, the fixes from the
  first dry run on the author's archive), `v0.1.0`
  (2026-11-07, everything through milestone 8 and the fixes of 2026-11-05), and the
  pre-releases `v0.1.0-rc.1` and `rc.2`, from milestone 1 only. Pushing a tag `vX.Y.Z` publishes a release
  (DESIGN.md section 10). Don't tag a release without the author.

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
| Orphan sidecars (F11): found by the full pass, deleted once seen gone for the grace period | `src/sync/orphans.ts`, `full-pass.ts` | 7 |
| Filing: readiness, the plan, moving, putting back, matching faces, the filing job | `src/core/filing.ts`, `face-match.ts`, `src/filing/`, `src/sync/job.ts` (`file`) | 8 |

**The daemon's jobs:** account upkeep and the check, the full pass (with orphan sidecars, F11) and sync (F1–F10
without F5), filing (moving, then putting back), and the upgrade
check.

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

## Checked before the first real run (2026-11-05)

Read every path the first run takes over an archive Immich already indexed, then tested it.
- **Four ways to lose data, fixed** (DESIGN.md section 5; tests in `src/sync/first-contact.test.ts`, the merge's and
  tags' unit tests, and "a copy learned after its unit was trashed…" in `reconcile.test.ts`; each test failed before
  its fix):
  1. a sidecar Immich doesn't know (made after it indexed the photo: by Darktable, or F2) lost its tags, title,
     rating and description on the second reconcile, to the copy that never read it: a refresh doesn't read it but
     updates the asset, which looked like catching up;
  2. a reject (-1), which Immich reads as unrated, was cleared after any refresh;
  3. without a base, a Darktable change Immich hadn't read lost to Immich's older value whenever anything else had
     updated the asset since (a favorite, a job);
  4. a new account's copy of a photo in the trash restored it.

  The fix: each copy is compared with what it said itself at the last sync (`SyncedValues.seen`), a copy the last sync
  didn't see takes the unit's state, and without a base the sidecar's values come first. Also, descriptions compare
  without surrounding spaces, as Immich reads them (163 of the author's sidecars hold `"AppleMark\n"`, which would
  have been rewritten for nothing).
- **A read-only scan of the author's 18,229 sidecars** with the daemon's own rules (not kept: it was run on their
  files): 10,557 would be written on the first run, nearly all to add `TagsList` with the title's tag; 103 rejects; 9
  titles with a `/`, reported as conflicts and left alone; 139 Darktable duplicates' sidecars; no `TagsList` yet.
- **A rehearsal on copies of 47 of the author's photos** (RAW and JPEG, rejects, duplicates, odd names, orphans, the
  titles with `/`, three inbox photos without sidecars), indexed by Immich first, with edits made in Immich, then the
  daemon's dry run and a live run:
  - the dry run changed nothing; the live run moved, deleted or changed no media file and deleted no sidecar;
  - no tag or keyword was removed from any sidecar, and no rating, title, description or GPS changed, except the
    Immich edits reaching Darktable's fields;
  - what was added: `TagsList` with the title's tag (22), the capture time's zone (F6, 10), `mediatriage:Accounts`
    (4), and keywords Immich read from the image file itself (older JPEGs carry them) into Darktable's fields;
  - Darktable's own data was the same in all 55 sidecars (exiftool writes Darktable's attributes as elements, and
    drops empty ones), and darktable-cli rendered three edited photos pixel for pixel the same from the original and
    the rewritten sidecars;
  - Darktable's duplicates' sidecars, a `name.xmp` sidecar and two orphans were left byte for byte as they were.
- **Known, not data loss:** where a sidecar has no `TagsList` and the image file embeds one, Immich shows the file's,
  so `copyInStep` never holds and that copy is refreshed again each time its unit is reconciled (an hour apart at
  most). **Fixed in `v0.1.1`:** `TagsList` is written there too (next section).

## The first dry run (2026-11-07)

`v0.1.0`, on the author's server, over about 20,000 photos and videos. It changed nothing (no file's ctime moved),
and the libraries matched. It found, by reading the planned writes against the files (DESIGN.md section 5):
- **Embedded tags came back into Darktable:** older JPEGs embed a `TagsList` from another program, with tags since
  reorganized in Darktable. Immich showed those, and the first run's union added them to Darktable's fields: about
  900 photos would have regained old `People|Family|…` tags. **Fixed:** the image file's own tags are read
  (`Exiftool.readImage`); on first contact a copy's tag the image embeds, and Darktable's fields don't hold, isn't an
  addition; and `TagsList` is written where Immich would show the image's tags (`Wanted.tagsList`).
- **Made-up capture dates:** with no date in the image or the sidecar, Immich's date is the file's time, and the merge
  wrote it as the capture time (16 archive photos, 147 inbox files). **Fixed:** a copy's date isn't a side then.
- **False orphans:** 86 sidecars beside links to files, which Immich indexes and the full pass skipped. Never deleted
  (the last check before deleting lists links), but reported and reconciled each pass. **Fixed:** links to files count.
- Tests: three in `src/sync/first-contact.test.ts`, each failing before its fix; unit tests for the image facts,
  `planWrite`'s `tagsList`, and the full pass's links.
- **What a dry run doesn't show:** filing (it looks for `Promote` in recorded units, and a dry run records none), and
  more than the first 20 writes per batch. Its warnings and errors are on stderr: capture with `2>&1`.
- **`v0.1.1`'s dry run** (same day): no embedded tag comes back (Darktable's tag fields are written only for F10's
  named faces), no date for a photo without one, the real orphans only; about 12,900 sidecars to write on the first
  run. One harmless error: the sync stream's connection reset once, and the next run reads it again (a live run from
  its last acknowledged batch). **Worth doing:** log a dropped connection as a warning, and retry it at once.

## After going live (2026-11-08)

- **Filing moves Darktable duplicates** (decided by the author): a photo's `<stem>_01.<ext>.xmp` and so on go with
  it, keeping their numbers, without `Promote`. Before, such a photo wasn't filed. A name like a duplicate's counts as
  one only if no media file has it, and the collision number keeps the duplicates' new names free (DESIGN.md
  section 7). Tests: `src/filing/plan.test.ts`, `file.test.ts`.
- **The watcher took every `…_<digits>.<ext>.xmp` for a duplicate's** and ignored it: every Pixel photo
  (`PXL_20261031_212120738.jpg`), camera names like `DSC_0001.NEF`, and filed `…_01.jpg` photos. So a change made in
  Darktable to one of those reached Immich, and filing, only at the next daily full pass or stream event. Fixed:
  `unitOf` looks at the disk, as `sidecarOwner` does (DESIGN.md section 3; three new cases in `watch.test.ts`, which
  failed before).
- The author's Immich fork now has the F1 patch (`IMMICH_FIND_NEW_SIDECARS`, `v3.3.6`); `reads_new_sidecars = true`
  once the server runs it.

## The refresh loop (2026-11-09, `v0.1.3`)

Live on the author's server, about 60 photos were reconciled every few seconds from about 20:00 on 2026-11-08, each
time asking Immich to read the sidecar again. Immich's metadata queue reached 32,000 reads of those photos by morning,
and new phone photos stayed gray behind them. The author stopped the service, the queue was emptied, and Immich's
"Missing" jobs caught up the rest. Two causes, both fixed (DESIGN.md section 5), each with a test that failed first:
- **A copy that can't show its sidecar's values was asked again on every pass.** Immich shows the image's own
  `ImageDescription`, even blank, over the sidecar's description, and stores some characters differently, so such a
  copy never holds what the sidecar says. Each read's own stream events brought the unit back, and once Immich's queue
  was over an hour deep, every pending read was asked for again too. Now the unit's record keeps the sidecar each copy
  was last asked to read (a hash, `SyncedValues.asked`): it isn't asked again for the same one, except a day on if it
  wasn't updated since (a lost request). Test: `src/sync/first-contact.test.ts`, "a copy that can't show".
- **A value starting with a space never got written.** exiftool writes the first value of each field without its
  leading space, so a tag Darktable holds as `" California"` beside `"California"` (sorted first) never reached
  `TagsList` as itself: the same file was written, and every copy refreshed, on every pass. Values are now compared as
  exiftool writes them (`asWritten` in `src/core/xmp.ts`). Tests: `xmp.test.ts` and `sidecar.test.ts`.

On the author's server: `v0.1.3` installed with `media-triage upgrade` (2026-11-09), and a 5-minute dry run there
reconciled the 105 units waiting in the stream: it would write only the 6 new phone photos' sidecars (their capture
time and GPS), and none of the looping ones. The service is started again by the author.

Not changed: an account whose session was revoked is warned about on every run ("account left out of sync"); Jess's
was revoked when her phone app was set up, and the warning repeated every few seconds. Logging it once per change
would be quieter.

## Filing at night (2026-11-11, `v0.2.0`)

The author found filing heavy and disruptive: every move has Immich scan, read each new copy in every account and drop
the old ones, at whatever hour a batch was promoted. Now filing moves units only in a daily window, the hour from
`filing.at` (`"HH:MM"`, the server's local time, default `"04:00"`; DESIGN.md section 7, `src/core/filing-window.ts`).
The filing job still runs every minute for putting back and finishing a plan cut short, which aren't limited to the
window, nor is a dry run. A daemon that isn't running for the whole window files nothing until the next day's: no
catch-up, so a restart in the afternoon doesn't move anything. The smoke test sets `at` to the time it starts.

On the author's server: `at = "02:00"` (its time zone is America/Chicago).

## Next: running it for real

The code is done. What's left is outside this repository. Every write to real files needs the author; the F1
patch can be written before that.
1. [x] **A release:** `v0.1.0`, tagged at the author's request on 2026-11-07.
2. **F1, in the author's Immich fork** (not here): `refresh-metadata` reads a sidecar that appeared after Immich
   indexed the file. Then `immich.reads_new_sidecars = true`. Until then, sync warns for every minimal sidecar (F2)
   it makes, and Immich doesn't read those sidecars, nor others made after it indexed a photo; nothing is lost
   (since 2026-11-05), they're just not seen in Immich. On a server without the patch, Immich's own admin job
   "Sidecar metadata, Discover" (not "Sync") makes it find and read them.
3. **Deploying on the author's server:** install a release and exiftool, log each account in, then `run --dry-run`
   over everything (DESIGN.md section 9). The author approves the first live write and the first live filing.
   **Done up to the start** (2026-11-07): installed, dry-run twice, approved; the service starts when the author runs
   the server's setup script.
   - **Libraries are matched by owner and name:** the configuration's names and folders must be the existing
     libraries', or upkeep creates new ones (a second copy of everything) or changes their folders. The dry run
     says "would create library" or "would update library … folders" if they don't match: none should appear.
   - The dry run lists the conflicts (titles with a `/`), the orphans it leaves alone, and the first 20 sidecars it
     would write in each batch, with warnings on stderr. It doesn't count what it would write per field, and can't
     show filing on a fresh state (DESIGN.md section 7).
   - The first live run writes most sidecars once (the title's tag for Immich, the capture time's zone), and asks
     Immich to re-read each. Darktable then lists them at its next start, to reload.
   - An account added later (a second account's libraries) is safe to add while sync runs: its copies take each
     unit's state, the trash included.

**Worth doing, not needed to run:**
- Removing GPS or a date when a side drops one (now ignored, so nothing is lost; milestone 6).
- Faces put back with Immich's own recognition: only faces added by hand are tested end to end, since the
  development Immich has no machine learning.
- A Live Photo and a video in the smoke test: filing them is covered by the plan's unit tests only.

## Milestone 8, filing (done 2026-11-05)

DESIGN.md section 7 (`Promote`). Decided with the author (2026-11-04): while filing puts a unit's per-account state
back, sync leaves it alone (DESIGN.md section 7, "Holding the unit"). What milestone 7 gives it: each sidecar's
`mediatriage:Accounts` (F9); the state's faces, deleted ones included (`SyncStore.facesOn`); the reconcile's
catching-up rule (`ReconcileContext.refreshing`).

1. [x] **Readiness and `Promote/Needs a title`** (done 2026-11-04; `ReconcileReport.ready` and `notReady`, with what
   filing needs in `ReadyUnit`; a copy catching up is now asked again when the sidecar changed meanwhile): the reconcile adds `Promote/Needs a title` to an inbox unit tagged
   `Promote` without a title, and removes it otherwise; `readiness` (pure, `src/core/filing.ts`): `Promote` and a
   title, no copy trashed, not rejected (`xmp:Rating` -1), settled (every copy in step with the sidecar and not
   catching up, and nothing changed for `timing.settle`: the latest of the sidecar's mtime and the copies'
   `updatedAt`).
2. [x] **The plan** (done 2026-11-04: `src/filing/plan.ts`, `planUnit`, looking at the disk only through `Disk`;
   `src/filing/store.ts`, `FilingStore`; `SyncStore.isBeingPutBack` for the hold. A unit with Darktable duplicates'
   sidecars isn't filed, and is reported: moving only the main sidecar would leave theirs as orphans, which F11 would
   delete): destinations for the media file, its sidecar, a Live Photo's video and its sidecar;
   collisions across the batch and on disk; the date (the sidecar's, else Immich's `localDateTime`), the creator, the
   root (photos or videos). Migration 6: a `filings` table (the unit, its moves, its old assets, its status).
3. [x] **Moving** (done 2026-11-04: `src/filing/file.ts`, `fileBatch`, `finishPlanned`; the reconcile's hold; the
   daemon's `filing` job, `Sync.file` in `src/sync/job.ts`; tested on temporary files, `file.test.ts`, and end to end,
   "filing moves a ready unit…" in `reconcile.test.ts`): remove `Promote` and `Promote/Needs a title` from the sidecar, record the plan, `link()` then
   `unlink()` each file (refusing other filesystems and existing names), carry the unit's record to the new path
   (F10's made tags and regions with it), finish an interrupted batch at start, and ask Immich to scan the libraries
   holding the old and new paths (admin session). The daemon's `filing` job runs every minute over inbox units tagged
   `Promote`. A dry run logs the plan.
4. [x] **Putting back** (done 2026-11-04, with step 5: `src/filing/restore.ts`, `restorePending`, run by the filing
   job; tested end to end with a favorite, an album, an archived copy and a face added by hand, all put back): while a unit is being put back, the reconcile leaves its `Accounts` (F9), named-face tags and
   regions (F10) alone. Once each account has its new copy: favorite, visibility and albums from the sidecar's
   `Accounts`; then check that the old copies are offline or gone (`getAsset` only). A time limit, then a report.
5. [x] **Faces** (done 2026-11-04: `src/core/face-match.ts`; only hand-made faces are tested end to end, since the
   development Immich has no machine learning; reassigning and deleting are tested as rules): match the new copy's faces to the old copy's (IoU above 0.5, pure), wait for detection and recognition
   (time limit), reassign, add the hand-made ones, delete the deleted ones; with `mirrors_face_corrections`, on one
   copy only.
6. [x] **Smoke test** (done 2026-11-05: `test/immich/smoke.ts`): the daemon, run live against the development Immich
   with two fresh accounts and four inbox photos, filed two promoted in Darktable (alike, so the second got `_01`),
   held one promoted in Immich without a title with `Promote/Needs a title` until the other account gave it a title
   in Immich, then filed it, and left the unpromoted one alone. A favorite and an archived copy (account one) and an
   album (account two) were put back on the new copies, and the old copies went offline. A restart filed nothing more,
   and both runs stopped cleanly on SIGTERM. Filing took about a minute after `Promote`, and putting back another.
   Its first run found a bug in milestone 6's sync, fixed (`d011c6f`): the first reconcile ran while only one
   account's copy was known and wrote the title tag; the other copy, learned a moment later, had read the sidecar
   before that, and the merge took the missing tag as a removal and dropped the title. A copy the last sync didn't
   read now isn't a side until it agrees with the sidecar (DESIGN.md section 5).

## Milestone 7, F9–F11 (done 2026-11-04)

DESIGN.md section 6.
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
4. [x] **F11, orphan sidecars** (done 2026-11-04): migration 5 (`units.gone`); the reconcile notes a missing media
   file as gone and does nothing else; the full pass lists orphans and conflict copies as it lists files;
   `handleOrphans` reports never-seen ones, notes seen ones gone, and deletes those gone for `timing.orphan_grace`
   (after listing the folder again), forgetting their records. Tested in `watch.test.ts`.
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
- **A change can reach Immich's sync stream a moment after the API call returns** (2026-11-04): a stream read at once
  missed a rating most times in a probe, and a read 2 seconds later always had it. Tests that change something
  through the API and then read the stream must read until the change arrives (`waitFor`), as `stream.test.ts` and the
  F9 and F10 tests in `reconcile.test.ts` do.
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

**7. F9–F11**, done 2026-11-04: Immich-only state, named faces, orphan sidecars.

**8. Filing**, done 2026-11-05: section 7, with putting the per-account state back, and the daemon's smoke test.

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
