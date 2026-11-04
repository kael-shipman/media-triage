# Resume here

The handoff for whoever works on media-triage next, person or agent. Start with the [README](README.md) (what it's
for) and [docs/DESIGN.md](docs/DESIGN.md) (how it works).

**Update this file after every completed step,** not just at the end of a session, so work can be picked up if a
session stops partway.

**Last updated:** 2026-11-03.

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
- **`run` starts and stops cleanly. Its only job so far is the upgrade check.**
- **Tests:** 214, all passing (`npx bun@1.4.4 test`), and the type check is clean.

## Next

**Exactly what to do next:** milestone 3: the Immich client.
1. **A development Immich** for integration tests: a Docker Compose file under `test/immich/` (upstream's
   `docker-compose.yml` for v3.3.x, Postgres and Redis included, machine learning off), plus a script that starts
   it, creates an admin and a second user through the API, and stops it. Tests that need it are skipped unless
   `MEDIA_TRIAGE_IMMICH_TESTS=1`.
2. **`src/immich/`:** add `@immich/sdk` (pin the version to the server's, 3.3.x). Wrap what the daemon needs:
   - login (`POST /auth/login`) and the session file, plus a `media-triage login <account>` command that asks for
     the password without echoing it, stores the token mode 600 in `<state>/sessions/<account>`, and checks it with
     `GET /users/me`;
   - the sync stream (`POST /sync/stream`, JSON lines) and acknowledgements (`POST /sync/ack`), for the types listed
     in DESIGN.md section 3;
   - assets by original path, metadata refresh (the asset jobs endpoint), trash and restore, favorite and
     visibility, albums, faces (`GET`/`POST`/`PUT`/`DELETE /faces`), people and people sharing, libraries
     (create, update exclusion patterns, scan), and cluster groups (invite, accept).
3. **The path map:** translate between Immich's paths and local ones, both ways (`immich.path_map`).

Check each call's request and response shapes in the SDK; the server's `/api/spec` is the reference.

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
