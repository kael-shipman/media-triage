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
- **Workflows:** `ci.yml` (push and pull request) and `release.yml` (`v*` tags), not yet run on GitHub.
- **`run` starts and stops cleanly. Its only job so far is the upgrade check.**
- **Tests:** 88, all passing (`npx bun@1.4.4 test`), and the type check is clean.

## Next

**Exactly what to do next:** milestone 1, step 5: CI and releases.
1. `scripts/build.ts`: `bun build --compile` for `bun-linux-x64` and `bun-linux-arm64`, with
   `--define MEDIA_TRIAGE_VERSION='"X.Y.Z"'` from the tag (or `package.json`), into `dist/`, plus `dist/SHA256SUMS`.
   Check that a built executable reports its version and that `IS_COMPILED` is true in it.
2. `.github/workflows/ci.yml` (on push and pull request: install, type check, test, build) and `release.yml` (on a
   `v*` tag: the same, then a GitHub release with the two executables and `SHA256SUMS`, marked pre-release if the tag
   has a hyphen).
3. An end-to-end check: tag `v0.1.0-rc.1` and `v0.1.0-rc.2`; install rc.1 with `install.sh --prerelease --version`,
   then run its daemon with `upgrade.prerelease = true` and watch it upgrade itself to rc.2 and exit 75.

## Milestones

Each step ends with tests passing, a commit, and this file updated.

**1. Foundation**
1. [x] Repository, README, design, RESUME.
2. [x] Command line (`help`, `version`, `init`, `config`, `run`), TOML configuration with validation, state database
   (`bun:sqlite`), logging.
3. [x] Upgrades (`upgrade`, and the daemon's scheduled check), tested against a local fake release server.
4. [x] The installer (`install.sh`).
5. [ ] CI (`.github/workflows/ci.yml`) and releases (`release.yml`); a first pre-release to try the installer and an
   upgrade end to end.

**2. The pure rules** (`src/core/`, no I/O)
1. [ ] Tags: translation between the tools, `dc:subject`, three-way merge (F4).
2. [ ] Titles (F3).
3. [ ] Filing names and collisions (section 7).
4. [ ] Folder dates and exclusion patterns, tested against picomatch (section 8).
5. [ ] Orphan sidecars: which media file a sidecar belongs to (F11).

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
