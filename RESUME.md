# Resume here

The handoff for whoever works on media-triage next, person or agent. Start with the [README](README.md) (what it's
for) and [docs/DESIGN.md](docs/DESIGN.md) (how it works).

**Update this file after every completed step,** not just at the end of a session, so work can be picked up if a
session stops partway.

**Last updated:** 2026-11-04.

## Where things stand

- **Built:** the command line (`help`, `version`, `init`, `config`, `run`), the TOML configuration with every setting
  checked (unknown keys are errors), the state database with numbered migrations, the job scheduler (one job at a
  time), and logging (journal priorities under systemd).
- **Upgrades:** `media-triage upgrade` (`--check`, `--to`), and the daemon's scheduled check, which exits with
  status 75 after upgrading so systemd restarts it. Tested against a fake release server; the daemon's own path still
  needs the end-to-end check in step 5, with real executables.
- **The installer,** `install.sh`: picks the release, checks its hash and its `version`, installs into `~/.local/bin`,
  runs `init`, and optionally writes and enables a user or system systemd unit. Tested with dash against a fake
  release server, with `systemctl` stubbed. shellcheck is clean (`npx shellcheck -s sh install.sh`).
- **Builds:** `bun run build [version]` makes `dist/media-triage-linux-{x64,arm64}` (about 110 MB each) and
  `SHA256SUMS`. Checked: the executable reports its version, knows it's compiled, and embeds the example config.
- **Workflows:** `ci.yml` (every push and pull request: type check, tests, build) and `release.yml` (`v*` tags:
  the same, then a GitHub release). Both pass on GitHub.
- **Releases:** `v0.1.0-rc.1` and `v0.1.0-rc.2`, pre-releases made for the end-to-end check: the foundation only, no
  triage yet.
- **End-to-end check, passed 2026-11-03:** installed rc.1 with `curl … install.sh | sh` into a sandbox, ran its
  daemon with `prerelease = true`, and it upgraded itself to rc.2 a minute later and exited with 75. Started again,
  it ran rc.2 and scheduled its next check six hours out.
- **The pure rules** (`src/core/`, milestone 2):
  - `tags.ts`: translating tags between the tools, `dc:subject`, and the three-way merge (F4);
  - `titles.ts`: the `Title/…` tag and what a title may hold (F3);
  - `naming.ts`: filing names exactly like the Darktable preset, wall times from EXIF, collision numbers shared by a
    Live Photo's two files;
  - `folder-dates.ts` and `exclusions.ts`: which names a date-limited library allows, and the exclusion patterns
    for it, checked against picomatch and fast-glob by fuzzing and a real crawl (about 44 patterns per level);
  - `orphans.ts`: which media file a sidecar belongs to, Darktable duplicates included (F11).
- **A development Immich** (milestone 3, step 1): `test/immich/compose.yml`, upstream's v3.3.5 stack without machine
  learning, on `127.0.0.1:2284`, the server running as the developer's user, the database in memory. `bun run immich
  up` starts it and creates two made-up users (the admin `alex@example.com`, and `sam@example.com`), and turns off
  machine learning and the version check; `down` deletes everything. `harness.ts` holds what tests share
  (`describeImmich`, `mediaFolder`, `api`, `waitFor`). A smoke test checks that a library over the media folder indexes
  `test/fixtures/photo.jpg` at Immich's path, with its EXIF date. Starting takes about a minute (the images are
  cached after the first pull).
- **`run` starts and stops cleanly. Its only job so far is the upgrade check.**
- **Login and sessions** (milestone 3, step 2): `src/immich/client.ts` (`ImmichClient`: one account's session, every
  SDK call made with its own options, errors as `ImmichError` with the HTTP status), `sessions.ts` (session files,
  mode 600, refused if others can read them), `login.ts`, and `media-triage login <account>` (no echo on a terminal,
  first line of stdin otherwise; logging in again ends the old session). `@immich/sdk` is pinned at 3.3.5. Checked
  by hand through a pseudo-terminal, and with the compiled executable.
- **The sync stream** (milestone 3, step 2): `src/immich/sync.ts`. `syncStream(client)` asks for DESIGN.md
  section 3's types, reads the response line by line (`jsonLines`), and yields batches of up to 1,000 changes, each
  with the acks to send after acting on it (`acknowledge`): the last of each type. A reset arrives as a batch of its
  own (`reset: true`). Also `checkpoints` and `forgetCheckpoints`. Tested against the development Immich: a first full
  read, nothing after acknowledging, favorite, trash, album, person and face changes, a forced reset, and the
  `AssetsV1` refusal. Immich's own jobs update a person shortly after a face is added, so the stream reports the
  person again; tests wait for those jobs.
- **Assets and the path map** (milestone 3, steps 2 and 3): `src/immich/assets.ts`: `libraryPages` and
  `searchPages` (structured search, pages of 1,000), `findByPaths` (500 paths a search), `getAsset`, and bulk
  `refreshMetadata`, `trashAssets`, `restoreAssets`, `setFavorite`, `setVisibility` (1,000 IDs a request; Immich's body
  limit is above 4 MB). `src/core/path-map.ts`: Immich's paths to local ones and back, longest folder first. Tested
  against the development Immich, which also showed:
  - searches include trashed, archived, hidden and offline assets, but not locked ones; a locked asset reads like a
    missing one without the PIN;
  - a missing file becomes offline **and** trashed, and both clear when it's back (the F8 question below);
  - `refresh-metadata` ignores a sidecar that appeared after indexing (the F1 question below).
- **Albums, faces and people** (milestone 3, step 2): `albums.ts` (list, create, add and remove in bulk; adding twice
  or removing what isn't there is fine), `faces.ts` (read, add by hand, reassign, soft delete), `people.ts` (list,
  create, rename in bulk, share all, list shares). Found and handled:
  - the face reassign call is `PUT /faces/{person}` with the face's ID in the body (DESIGN.md section 7 corrected);
  - a person's API ID is its person group's, the same in every account of a cluster group;
  - `GET /people` lists only people with a visible face on the account's assets;
  - sharing people needs both accounts in one cluster group (tested as a refusal for now; the working case comes with
    the cluster-group calls);
  - the SDK reads errors from calls without a response body as text; `toImmichError` now parses them.
- **Libraries, users and cluster groups** (milestone 3, step 2): `libraries.ts` (list, create, update, scan,
  statistics, validate folders, list users; lists Immich would refuse are refused first, naming the library) and
  `cluster-groups.ts` (the account's group, members, invite, invitations, accept; "reset facial recognition" is
  deliberately not wrapped). Checked against the development Immich: two accounts' libraries over the same folder each
  get their own assets; an account that joins a group keeps its named people; sharing people works once both are in
  one group.
- **Milestone 3 is done** (2026-11-04).
- **Milestone 4, step A (pure rules):** `src/core/libraries.ts` (each library's wanted state, and the plan against
  Immich's: create, update only what differs, report the unconfigured, refuse duplicates and too many patterns) and
  `classifyPath` in `src/core/folder-dates.ts` (allowed, rejected and why, or outside every dated level), checked
  against a real fast-glob crawl with the generated patterns. That crawl showed a dotted folder above a dated level
  (`Videos/My.Clips`) isn't excluded, contrary to what DESIGN.md said; corrected.
- **Milestone 4, step B:** `src/upkeep/accounts.ts` (`openAccounts`: each account's session, checked, or a problem
  saying what to do) and `src/upkeep/cluster.ts` (`joinClusterGroup`: invite from the first account, accept with the
  joiner's session, re-read to confirm; `--dry-run` only reports). Tested with fresh users.
- **Milestone 4, step C:** `src/upkeep/libraries.ts` (`upkeepLibraries`: owners by email from the admin's user
  list, the plan, create only for accounts in the group, correct, scan what changed, report the unconfigured) and
  `waitForLibraryQueue` in `src/immich/libraries.ts`. Tested end to end: a date-limited library indexes exactly the
  allowed files, and moving its cutover takes the newly excluded ones out.
- **Milestone 4, step D:** `src/upkeep/check.ts` and `media-triage check`. Tested against the development Immich: a
  correct library passes; leaked assets fail, and still fail once offline in the trash; patterns that leave out an
  allowed folder show its files as missing; a wrong path map is a failure, not a pass. Found on the way: matching the
  hidden-file patterns against local paths inside a hidden folder (like Emmer's `~/.data/archive`) excluded
  everything, so exclusions are matched against Immich's paths. `fast-glob` and `picomatch` are runtime dependencies
  now (pinned, as Immich uses them); `src/core/media.ts` lists Immich's extensions.
- **Milestone 4, step E:** `src/upkeep/people.ts` (`upkeepPeople`: share all both ways with write access every pass,
  then copy names onto records still unnamed; conflicts reported) and `getPerson`. Found in 3.3.5: renames already
  reach the records shared with write access, new records for a shared person start with its name, and the people
  list hides unnamed people with fewer than 3 faces (so those records are read one by one).
- **Cleanup:** milestone 2's tests held a real date, a real person's name and real folder names; replaced with
  made-up ones (`7b4143a`). They remain in the repository's history.
- **Tests:** 260 without Immich, all passing (`npx bun@1.4.4 test`), and 266 with the development Immich (as of
  milestone 3)
  (`MEDIA_TRIAGE_IMMICH_TESTS=1`). The type check is clean, and covers `test/` too.
- **Design updated 2026-11-04** (approved by the author): sync covers the whole archive, not just the inbox, and a
  new section 13 (scale) says how that stays cheap. Section 3 corrected from 3.3.5's source: `AssetsV2` and
  `AlbumsV2` (3.3.5 refuses `AssetsV1`), no paths in the stream (looked up once per asset, in bulk where there are
  many), `AssetFacesV3` covers the cluster group, and `SyncResetV1`.

## Next

**Exactly what to do next:** milestone 4, account upkeep (DESIGN.md, section 8). Milestone 3, the Immich client, is
done: `src/immich/` wraps every call the daemon needs, each tested against the development Immich (`bun run immich
up`, then `MEDIA_TRIAGE_IMMICH_TESTS=1 bun test`). Milestone 4 doesn't depend on the open questions below.

0. [x] **Pure rules** (step A): the library plan and `classifyPath`.
1. [x] **Accounts:** for each configured account, load its session (`loadSession`; no session means skip the account
   with a message saying to run `media-triage login <account>`), and read its user ID and cluster group (`me()`).
   Library work needs the admin account's session.
2. [x] **Cluster group:** every account joins the first account's group (`inviteToClusterGroup` from the first account,
   `acceptClusterGroupInvitation` with the joining account's session), **before** any library of the joining account is
   created.
3. [x] **Libraries:** for each `[[immich.libraries]]`, the wanted state: owner (the account's user ID), name, folders,
   and exclusion patterns (the hidden-file patterns, the configured `exclude`, and `datedExclusions` from
   `src/core/exclusions.ts`; at most 128). Match existing libraries by owner and name (`listLibraries`). Create the
   missing ones, correct folders and exclusion patterns that differ, and scan only what changed. Report libraries in
   Immich that aren't configured; never delete one. Everything is idempotent, and `--dry-run` only reports.
4. [x] **`media-triage check`:** for each date-limited library, classify every asset's path with `allowedSince`
   (`src/core/folder-dates.ts`), and crawl the local folders at its levels (through the path map) for files the rule
   allows that aren't in the library. Fail loudly on either; also report undated names and inbox files dated before
   `since`. It runs after every scan and on demand.
5. [x] **People:** share all people both ways with the write role (`shareAllPeople`), then copy names onto the other
   accounts' unnamed records for the same person ID (`listPeople`, `renamePeople`).
6. **In the daemon:** run 1–5 at start and on every full pass, as one scheduler job.

Test each against the development Immich with fresh users (`newUser` in `test/immich/harness.ts`), since joining a
cluster group changes an account for good.

**Open question for the author, F1 (needed by milestone 6):** a metadata refresh re-reads only a sidecar Immich
already knows. Immich looks for sidecars when it first indexes a file, and `refresh-metadata` doesn't look again
(checked in the source and tested: `src/immich/assets.test.ts`). So every new phone photo whose sidecar F2 creates
after Immich indexed it would never be read, and the same goes for Darktable's first sidecar on an archive photo.
The API has no per-asset way to look again. Options:
- (a) **The fork:** make `refresh-metadata` look for a sidecar first (`asset.service.ts`, `run`: queue
  `SidecarCheck`, whose follow-up job is the extraction). One line, and a likely upstream fix too. media-triage would
  get a setting, like `mirrors_face_corrections`.
- (b) **Stock Immich:** the admin's "discover sidecars" queue (`PUT /api/queues/sidecar`, `start`, not forced),
  throttled. It re-extracts the metadata of every asset Immich knows no sidecar for, in every account (even when it
  finds none), so it's cheap only once almost every asset has a known sidecar. That means creating minimal sidecars
  for all media without one, archive included: a one-time burst of new files that sync everywhere.
- (c) Both: (a) where the server has it, (b) otherwise.

**Open question for the author, safety (needed by milestone 6, F8):** in 3.3.5, a library file that goes offline
(missing, or newly excluded) gets `isOffline` **and `deletedAt`** (`library.service.ts`, around line 549), and coming
back online clears both. The sync stream has no `isOffline`, so going offline looks exactly like being trashed. As F8
is written, a change to one account's exclusion patterns would trash the other accounts' online copies, and emptying
their trash 30 days later deletes the original files. Proposal: F8 mirrors a trash or restore only after checking
through the API that the copy isn't offline, and never mirrors going offline or coming back online.

**Open question for the author** (needed by milestone 6, the watcher): which folders count as
"the archive" for watching and the full pass. `paths.archive` can be the root of a larger tree (Setup files, backups),
and watching all of it is wasted work. Proposal: the folders of every configured library, mapped to local paths, plus
the inbox sources.

## Milestones

Each step ends with tests passing, a commit, and this file updated.

**1. Foundation**
1. [x] Repository, README, design, RESUME.
2. [x] Command line (`help`, `version`, `init`, `config`, `run`), TOML configuration with validation, state database
   (`bun:sqlite`), logging.
3. [x] Upgrades (`upgrade`, and the daemon's scheduled check), tested against a local fake release server.
4. [x] The installer (`install.sh`).
5. [x] CI (`.github/workflows/ci.yml`) and releases (`release.yml`); a first pre-release to try the installer and an
   upgrade end to end.

**2. The pure rules** (`src/core/`, no I/O)
1. [x] Tags: translation between the tools, `dc:subject`, three-way merge (F4).
2. [x] Titles (F3).
3. [x] Filing names and collisions (section 7).
4. [x] Folder dates and exclusion patterns, tested against picomatch and fast-glob (section 8).
5. [x] Orphan sidecars: which media file a sidecar belongs to (F11).

**3. Immich client** (`src/immich/`), done 2026-11-04
1. [x] A development Immich for the integration tests (`test/immich/`).
2. [x] Login and sessions, the sync stream, and the asset, album, face, people, library and cluster-group calls.
3. [x] The path map (`src/core/path-map.ts`).

**4. Account upkeep** (section 8): libraries, exclusion patterns, `check`, cluster group, people. Needed first by the
author's setup.

**5. Sidecar I/O:** exiftool through `exiftool-vendored`: read and write the fields, create minimal sidecars, the
custom namespace (F9), face regions (F10). Fixtures: a Darktable sidecar, an Immich one.

**6. Sync:** the file watcher, dirty units, the reconcile loop (section 5), F1–F8.

**7. F9–F11:** Immich-only state, named faces, orphan sidecars.

**8. Filing:** section 7, with putting the per-account state back.

## Rules

- **No personal data in this repository:** no names, emails, addresses or paths from a real setup. Examples use
  made-up ones.
- **Docs are part of done:** the README, DESIGN.md and this file stay current with the code.
- **Never test against a real archive first.** Use copies.
