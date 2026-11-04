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
- **Tests:** 223 without Immich, all passing (`npx bun@1.4.4 test`), and 231 with the development Immich
  (`MEDIA_TRIAGE_IMMICH_TESTS=1`). The type check is clean, and covers `test/` too.
- **Design updated 2026-11-04** (approved by the author): sync covers the whole archive, not just the inbox, and a
  new section 13 (scale) says how that stays cheap. Section 3 corrected from 3.3.5's source: `AssetsV2` and
  `AlbumsV2` (3.3.5 refuses `AssetsV1`), no paths in the stream (looked up once per asset, in bulk where there are
  many), `AssetFacesV3` covers the cluster group, and `SyncResetV1`.

## Next

**Exactly what to do next:** milestone 3, the Immich client, from step 2. Steps 1 and 2's login are done:
`bun run immich up`, then `MEDIA_TRIAGE_IMMICH_TESTS=1 bun test`. Next is the sync stream. The SDK's
`getSyncStream` reads the whole response as text, so read it with `fetch` and the SDK's types, line by line.
1. [x] **A development Immich** for integration tests (`test/immich/`).
2. **`src/immich/`:** wrap what the daemon needs:
   - [x] login and sessions, and `media-triage login <account>`;
   - **next:** the sync stream (`POST /sync/stream`, JSON lines) and acknowledgements (`POST /sync/ack`), for the types listed
     in DESIGN.md section 3;
   - assets by original path, metadata refresh (the asset jobs endpoint), trash and restore, favorite and
     visibility, albums, faces (`GET`/`POST`/`PUT`/`DELETE /faces`), people and people sharing, libraries
     (create, update exclusion patterns, scan), and cluster groups (invite, accept).
3. **The path map:** translate between Immich's paths and local ones, both ways (`immich.path_map`).

Check each call's request and response shapes in the SDK; the server's `/api/spec` is the reference.
Mind DESIGN.md section 13: list in bulk (search pages of 1,000), write in bulk (every call that takes a list of IDs),
and read the sync stream line by line.

**Open question for the author** (doesn't block milestone 3; needed by milestone 6, the watcher): which folders count as
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

**3. Immich client:** login and sessions, the sync stream, and the asset, face, album, library, people and
cluster-group calls. Integration tests against a development Immich in Docker Compose.

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
