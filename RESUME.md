# Resume here

The handoff for whoever works on media-triage next, person or agent. Start with the [README](README.md) (what it's
for) and [docs/DESIGN.md](docs/DESIGN.md) (how it works, and why). DESIGN.md is the source of truth: if something
you're about to build would change it, ask the author first.

**Update this file after every completed step,** not just at the end of a session, so work can be picked up if a
session stops partway. Each step ends with tests passing, the type check clean, a commit and a push; CI must stay
green.

**Last updated:** 2026-11-04. Milestones 1–4 of 8 are done. **Next: milestone 5, then 6.**

## Working on it

- **Bun 1.4** runs and builds it. Without Bun installed, `npx --yes bun@1.4.4` stands in for `bun`:
  - `bun test`: the unit tests (262), and the integration tests, skipped;
  - `bun run typecheck`: TypeScript, over `src/`, `scripts/` and `test/`;
  - `bun run build [version]`: executables for linux-x64 and linux-arm64 in `dist/` (`TARGETS=linux-x64` for one).
- **The development Immich** (`test/immich/`): upstream's 3.3.5 stack in Docker Compose, without machine learning, on
  `127.0.0.1:2284`, with made-up users (`alex@example.com`, the admin, and `sam@example.com`).
  - `bun run immich up` starts it (about a minute) and `bun run immich down` deletes everything. Leave it down when
    you stop: its database is in memory anyway.
  - `MEDIA_TRIAGE_IMMICH_TESTS=1 bun test` runs everything against it (301 tests). Run it twice in a row on one
    instance before calling a step done: tests must not depend on what other tests left behind.
  - Shared test helpers are in `test/immich/harness.ts`: `describeImmich`, `mediaFolder`, `photos`,
    `indexedLibrary`, `newUser` (fresh users, for anything that changes an account for good, such as joining a
    cluster group), `configFor`, `api`, `waitFor`.
- **Immich's source**, for checking behavior: the fork's clone at `~/Desktop/tmp-repos/immich`, branch `twins`, based
  on v3.3.5. Look in `server/src`: `controllers/`, `dtos/`, `services/`, `repositories/`. Use Immich only through
  its API, never its database.
- **Releases:** `v0.1.0-rc.1` and `rc.2` exist, from milestone 1 only. Don't tag a release without the author.

## Where things stand

| What | Where | Milestone |
|---|---|---|
| Command line: `help`, `version`, `init`, `config`, `run`, `login`, `check`, `upgrade` | `src/cli.ts` | 1, 3, 4 |
| Configuration (TOML, every setting checked), state database (numbered migrations), scheduler (one job at a time; a run can ask to run again sooner), logging | `src/config.ts`, `state.ts`, `scheduler.ts`, `log.ts` | 1 |
| Self-upgrade, installer, CI and releases, checked end to end with two pre-releases | `src/upgrade.ts`, `install.sh`, `.github/workflows/` | 1 |
| The pure rules: tags (F4), titles (F3), filing names (section 7), date limits and their exclusion patterns, path classification, orphans (F11), the path map, the library plan, Immich's extensions | `src/core/` | 2, 3, 4 |
| The Immich client: sessions and `login`, the sync stream, assets, albums, faces, people, libraries, cluster groups | `src/immich/` | 3 |
| Account upkeep, at start and every full pass: accounts, the cluster group, libraries, the check, people | `src/upkeep/` | 4 |

**The daemon's jobs so far:** the upgrade check, and account upkeep. Nothing reads or writes sidecars yet, and
nothing syncs or files.

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

## Decided by the author, 2026-11-04

These shape milestone 6; DESIGN.md has each.
- **F1, sidecars Immich never reads:** fixed in the author's Immich fork, not worked around here. The fork's
  `refresh-metadata` will look for a sidecar first. That patch belongs to the fork's track and **isn't written yet**
  (the project's task 0058); it's needed before sync goes live, not to build it. Milestone 6 adds a setting, like
  `mirrors_face_corrections`, saying whether the server has the fix.
- **F8, offline isn't trash:** a trash or restore is mirrored only after reading through the API (`getAsset`,
  `isOffline`) that the copy it happened to isn't offline. Going offline and coming back online are never mirrored.
- **The covered folders:** the daemon watches and passes over every configured library's folders (mapped to local
  paths) plus the inbox's sources, not everything under `paths.archive`, which is only where filing puts files.
- **The check moves out of upkeep** when sync is built (milestone 6, step 1 below).

## Next: milestone 5, sidecar I/O

DESIGN.md sections 6, 9, 10 and 13. A new module, `src/sidecars/` (or similar), with its tests beside it.

1. **exiftool.** Add `exiftool-vendored`, run as one long-lived process (section 13), always with
   `-overwrite_original` (section 9: `*_original` backups would sync everywhere). Immich 3.3.5 uses `exiftool-vendored`
   35.21.0 (the latest is 39.1.0); prefer the same major unless there's a reason.
   - **The executable uses the system's exiftool** (Debian's `libimage-exiftool-perl`; section 10), because the Perl
     script `exiftool-vendored` brings can't run from inside a Bun-compiled executable. Pass its path explicitly, and
     report clearly when it's missing.
   - **This machine has no system exiftool**, but has Perl, so tests can use the one `exiftool-vendored` brings.
     Check early that the compiled executable finds the system's (CI's runner can `apt-get install
     libimage-exiftool-perl`).
2. **Reading and writing a sidecar's fields:** `xmp:Rating`, `dc:title`, `dc:description`, `dc:creator`,
   `dc:subject`, `lr:hierarchicalSubject`, `digiKam:TagsList`, `exif:DateTimeOriginal`, GPS, and `x:xmptk` (who wrote
   last, F5). Write only the fields that change, and stat the file again just before writing (section 5, step 3).
   `src/core/tags.ts` and `titles.ts` already have the rules to apply.
3. **Minimal sidecars** for F2: `<file>.<ext>.xmp` with only `dc:creator`.
4. **The daemon's own namespace** (F9): each account's favorite, visibility and album memberships, with the exiftool
   config that defines it. Then check, on copies, that both other writers keep it:
   - **Immich:** a sidecar Immich rewrites (rate the photo through the API in the development Immich, which writes
     the sidecar with its own exiftool, then read it back);
   - **Darktable:** 5.6.1 is installed here (`darktable`, `darktable-cli`). Work out how to have it rewrite a copy's
     sidecar (not checked yet: perhaps importing the copy, or Lua), always with a throwaway library and config folder
     (`--library :memory: --configdir <temporary folder>`), never the author's own (`~/.config/darktable`).

   If either drops the namespace, stop and tell the author: F9 depends on it.
5. **Face regions** (F10): `mwg-rs:Regions`, each with its box and name, in MWG's normalized coordinates.
6. **Fixtures** in `test/fixtures/`: a Darktable sidecar and an Immich one, made up from the shapes DESIGN.md
   describes, with no personal data (made-up names, made-up dates). A tiny photo with a made-up EXIF date is made with
   Python's Pillow (see the existing `photo.jpg` and `photo-2019.jpg`).

## Then: milestone 6, sync

DESIGN.md sections 3, 5 and 6 (F1–F8) and 13. Read "Decided by the author" above first.

1. **First, take the check out of upkeep.** Upkeep is one scheduler job, and the scheduler runs one job at a time.
   After changing a library, upkeep waits up to 30 minutes for Immich's scans so the check sees the result, and
   nothing else runs meanwhile. With sync running, that would hold up every sync for the wait. So: upkeep starts the
   scans and ends; the check becomes its own job, run when Immich's library queue is next idle
   (`libraryQueueIdle`). Update DESIGN.md section 8, which describes the wait.
2. **State:** each asset's ID, owner, library and path (the sync stream has no paths; look up new ones in bulk with
   `libraryPages` on a first run, after a reset, or when a batch has many new assets, and one by one with `getAsset`
   otherwise), and each unit's last-synced record (section 5), with the sidecar's size and mtime. New tables are new
   migrations in `src/state.ts`; never edit a released one.
3. **The watcher:** inotify over the covered folders, a watch per folder, with the `fs.inotify.max_user_watches`
   check (section 13). The full pass stats files and reads only sidecars that changed.
4. **The sync stream consumer**, per account: `syncStream` gives batches; act on a batch, then `acknowledge` its
   acks. A batch with `reset` is acknowledged and followed by a full read. `AssetFacesV3` reports other accounts'
   faces too (cluster group). Immich's own jobs touch a person again shortly after a face is added; the
   last-synced comparison makes that a no-op.
5. **The reconcile loop** (section 5) and F1–F8, with the merge from `src/core/tags.ts`. Each copy's tags come from
   `getAsset` (`tags`). Writes to Immich in bulk (`refreshMetadata`, `trashAssets`, `restoreAssets`).
6. **F1's setting** (whether the server reads new sidecars on refresh), and F8's offline check.

Before anything runs against the author's real files: a dry run over everything, and the author's approval of the
first live write (DESIGN.md section 9).

## Gotchas

- **picomatch reads `[!…]` as a literal "!"**, not a negation: write negated brackets as `[^…]`.
- **`Bun.spawnSync` blocks the event loop.** A child process that calls a `Bun.serve` running in the same test
  process deadlocks. Use `Bun.spawn` and await it.
- **`pkill -f <pattern>` can match your own shell command** and kill it.
- **`expect(promise).rejects` must be awaited**, or a failure can go unnoticed.
- **Paths in tests:** this repository is under a hidden folder on the author's machine, so anything that matches
  exclusion patterns must match Immich's paths, never local ones (the check's crawl does; see `src/upkeep/check.ts`).
- **Immich lowercases emails;** `newUser` makes lowercase ones.
- **The development Immich is shared by every test file:** other tests' libraries and people are there too. Filter
  by your own IDs, and use fresh users for anything that changes an account for good.
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

**5. Sidecar I/O:** exiftool, the fields, minimal sidecars, the custom namespace (F9), face regions (F10), fixtures.

**6. Sync:** the check as its own job, state, the watcher, the sync stream consumer, the reconcile loop, F1–F8.

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
