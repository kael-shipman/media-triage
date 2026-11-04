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
- **`run` starts and stops cleanly. Its only job so far is the upgrade check.**
- **Tests:** 88, all passing (`npx bun@1.4.4 test`), and the type check is clean.

## Next

**Exactly what to do next:** milestone 2, step 1: tags (`src/core/tags.ts`, DESIGN.md F4).
- Translating between the tools: Immich `A/B` ↔ Darktable `A|B`, where a `/` inside a Darktable part becomes `|` in
  Immich (Immich's own `getTagList` conversion) and back.
- `dc:subject`: every part of every hierarchical tag, once each.
- Leaving out Darktable's `darktable|…` tags.
- The three-way merge of tag sets against the last-synced set: additions and removals from any side, and a union
  when there's no last-synced set.

Pure functions, no I/O, with tests beside them.

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
