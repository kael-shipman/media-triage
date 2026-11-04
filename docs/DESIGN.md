# Design

How media-triage works, and why. The [README](../README.md) says what it's for. [RESUME.md](../RESUME.md) says what's
built and what's next. **Keep this file current with every change to the code.**

Written for Immich 3.3 and Darktable 5.6. References like `metadata.service.ts` are files in Immich's server source
(`server/src/`), or in Darktable's source, where the behavior described was checked.

## 1. What it is

One long-running program. It's started with an inbox folder and an archive folder, and does everything itself:
- keeps each photo's sidecar, Darktable's fields and every Immich copy of it in step (section 6);
- records in the sidecar what Immich keeps only in its database: favorites, archiving, albums and named faces
  (section 6);
- files what's tagged `Promote` into the archive, and puts that state back on the new copies (section 7);
- deletes sidecars whose photo is gone (section 6);
- keeps the Immich accounts set up: libraries and exclusion patterns, a privacy check, the cluster group, and shared
  people and names (section 8);
- upgrades itself (section 11).

**The whole archive, not just the inbox:** someone can tag, rate, title or name a face on a photo filed years ago, in
either tool or any account. So sync, the Immich-only state, named faces and orphan cleanup (sections 5 and 6) cover
every photo and video in the archive as well as in the inbox. Only filing (section 7) is limited to the inbox. That
means tens of thousands of files and assets, and section 13 says how the daemon keeps that cheap.

**Why one program:** these functions act on the same files and the same Immich assets, in a set order: merge, then
file. Separate tools would race each other. For example, a title and `Promote` might be added together, or a sidecar
write might land after a move. One process with one state database removes the races.

It runs on the machine that has the files and Immich. Besides Immich and Darktable, it's the only thing that writes
sidecars, so a file-sync tool like Syncthing never sees two machines editing the same sidecar.

**Generic code, personal docs:** the folders, the inbox sources and their creators, and the accounts and their
libraries all come from configuration. The filing pattern is the exception. It's hard-coded to the author's Darktable
export preset for now, and becomes a setting later.

## 2. Configuration

TOML, by default at `$XDG_CONFIG_HOME/media-triage/config.toml` (`~/.config/media-triage/config.toml`). Override it
with `--config` or `MEDIA_TRIAGE_CONFIG`. [examples/config.toml](../examples/config.toml) documents every setting.

| Section | What it holds |
|---|---|
| `[paths]` | The inbox, the archive, and the state folder |
| `[[sources]]` | Each inbox subfolder that's a source, with the creator its files get. Subfolders that aren't listed are left alone |
| `[immich]` | The server's URL, and a path map from Immich's paths (inside its container) to the daemon's, both ways (`src/core/path-map.ts`; the longest matching folder wins) |
| `[[immich.accounts]]` | Each account: a name used in logs and for its session file, and whether it's the admin |
| `[[immich.libraries]]` | Each account's libraries: folders, extra exclusions, and an optional "dated on or after" limit (section 8) |
| `[timing]` | Settle time before filing (5 min), orphan grace period (1 h), full pass (24 h) |
| `[upgrade]` | Automatic upgrades (section 11) |

**The state folder** defaults to `$XDG_STATE_HOME/media-triage` (`~/.local/state/media-triage`). It holds the SQLite
database, the Immich sessions and the logs. **Never put it inside a synced folder.**
- A file-sync tool copying a live SQLite file can corrupt it.
- The sessions are credentials.

## 3. Finding work

Changes come from three places. Each change marks a **unit** dirty: a media file, its sidecar, and a Live Photo's
video. Units in the archive count as much as units in the inbox (section 1).

1. **Files:** inotify on the inbox and the archive, with a watch per folder. It sees files arriving from the phones,
   Darktable's sidecars, and Immich's sidecar writes. A full pass at start, and then daily, catches anything missed.
2. **Immich, per account: its sync stream** (`POST /api/sync/stream`), the feed of changes the phone apps use. It
   asks for these types, all current in Immich 3.3 (which refuses `AssetsV1`: `sync.service.ts`, `syncAssetsV1`):
   - `AssetsV2`: trash (`deletedAt`), `isFavorite`, `visibility` (archived, locked), the library, the Live Photo's
     video;
   - `AssetExifsV1`: rating, description, dates;
   - `AlbumsV2` and `AlbumToAssetsV1`: albums and their assets;
   - `PeopleV1` and `AssetFacesV3`: people and their names, and each face's person, box, source and deletion.
     `AssetFacesV3` covers every asset in the account's cluster group, so once the accounts share a group, each
     account's stream also reports the faces on the other accounts' copies.

   **No paths:** an asset in the stream has its file name but not its path. The daemon looks up the path of each
   asset it hasn't seen before, and keeps every asset's ID and path in its state. A library asset's path never changes,
   since its identity is a hash of the path (`library.service.ts`), so each is looked up once (section 13).
   A locked asset is the exception: without the account's PIN, Immich leaves it out of searches and answers for it
   as for a missing one. So the daemon knows a locked asset's path only if it saw the asset before it was locked.

   **Acknowledging:** each line of the stream carries an acknowledgement (`<type>|<id>`). The server keeps one
   checkpoint per type, so after acting on a batch (up to 1,000 changes) the daemon acknowledges the last line of each
   type, including the stream's closing `SyncCompleteV1`. A restart resumes where it stopped, and so does a stream
   cut off before its end: what arrived is acted on and acknowledged. Lines that are only acknowledgements
   (`SyncAckV1`, the end of a backfill) and types the daemon doesn't know are acknowledged and otherwise skipped. When
   an account gains access to an album that already has assets, `AlbumToAssetsV1` also sends them, as
   `AlbumToAssetBackfillV1`.

   **Resets:** instead of changes, the server can send `SyncResetV1`. It does when the session was flagged for a
   reset, or when its last completed sync is more than 30 days old (`sync.service.ts`, `needsFullSync`), since older
   changes may have left its audit tables. The daemon acknowledges the reset, which clears the session's checkpoints,
   reads the whole account again as on a first run, and logs it.

   Tags have no sync type. A tag change reaches the daemon as Immich's own sidecar write (point 1), and the merge
   reads each copy's tags through the API.
3. **Its own clock:** settle times, filing's retries, the full pass, upgrade checks.

The daemon's own changes come back to it through all three. It compares them with the last-synced state, and does
nothing when they match.

## 4. Immich credentials

**The sync stream refuses API keys.** `sync.service.ts` throws "Sync endpoints cannot be used with API keys", so the
daemon needs a login session:
- **Logging in:** `media-triage login <account>` asks for the account's password once (without echoing it, or as the
  first line of stdin when that isn't a terminal), logs in (`POST /api/auth/login`), and checks the session with
  `GET /api/users/me`.
  - **It keeps only the session,** never the password: `<state>/sessions/<account>`, a JSON file with the token and the
    user ID and email it belongs to. The file is mode 600 in a mode 700 folder. A session file that others can read is
    refused.
  - **Logging in again** replaces the session and ends the old one (`POST /api/auth/logout`), so sessions don't pile
    up.
- **Revoking:** the session shows in the account's **Authorized devices** as `media-triage` on the daemon's host name,
  and revoking it there cuts the daemon off. Every request sends those names (`devicemodel` and `devicetype` headers),
  since Immich rewrites a session's device from its requests about once an hour (`auth.service.ts`,
  `validateSession`).
- **Access:** a session has full access to its account, more than an API key with chosen permissions. That's the
  price of the sync stream. Creating libraries for other accounts needs the admin's session (section 8).
- **Expiry:** Immich deletes sessions unused for 90 days (`session.repository.ts`, `cleanup`). Using one refreshes it
  hourly (`auth.service.ts`), so only a daemon stopped for 90 days needs a new login.
- **Which session:** the daemon keeps the login session itself. A child session (`POST /sessions`) would be deleted
  along with its parent (`session.table.ts`, cascade).

## 5. Reconciling a unit

All of a unit's work happens in one place, in this order, so nothing races:

1. **Read** the sidecar (exiftool), each account's copy (API), and the last-synced record (state).
2. **Merge** against the last-synced record (section 6).
3. **Write** only the fields that changed to the sidecar. Stat the file again just before; if it changed in the
   meantime, leave the unit for the next pass.
4. **Tell Immich:** refresh the metadata of every copy whose sidecar changed, and trash or restore copies (F8).
5. **Record** the new last-synced state, including the sidecar's new size and mtime, so the daemon doesn't reprocess
   its own writes, and the full pass can skip the sidecar until it changes again (section 13).
6. **File** the unit if it's ready (section 7).

If the state is lost, merge as a union, which never drops a tag, and report it.

## 6. Sync rules

- **F1. Refresh.** Any sidecar that changed, for any reason, leads to a metadata refresh of every copy with that path,
  in each account, batched. Immich never notices a sidecar-only change by itself: its watcher and scans look only at
  media files.
  - **A refresh re-reads only a sidecar Immich already knows** (checked against 3.3.5). It looks for sidecars when it
    first indexes a file (`SidecarCheck`), and `refresh-metadata` doesn't look again (`asset.service.ts`, `run`), so
    a sidecar that appeared later, such as one made by F2 just after Immich indexed the photo, isn't read. How the
    daemon gets Immich to find it is open (RESUME.md).
- **F2. Creator.** A file in an inbox source with no `dc:creator` gets the source's creator. An existing creator is
  never overwritten. Most new photos have no sidecar yet, so create a minimal `<file>.<ext>.xmp`.
- **F3. Title.** The tag `Title/<title>` (Immich) and `dc:title` (Darktable) stay equal.
  - Two different titles on one photo are a conflict: report it and change nothing.
  - A `/` or `|` in a title is refused: it would nest the tag in one of the tools.
- **F4. Tags.** Immich's `digiKam:TagsList` (`Parent/Child`) and Darktable's `lr:hierarchicalSubject` (`Parent|Child`)
  plus `dc:subject` (every part of every tag) stay equal, by a three-way merge against the last-synced set.
  - **Each tool shows each tag once,** in its own notation, because each reads exactly one field and never the other
    tool's:
    - Immich reads `TagsList`, or `HierarchicalSubject` when there's none (`metadata.service.ts`, `getTagList`);
    - Darktable reads `lr:hierarchicalSubject`, or `dc:subject` when there's none (`src/common/exif.cc`).
  - **Translating:** split on `|`, turn each `/` inside a part into `|`, and join with `/`. That's Immich's own
    conversion (`getTagList`), so a Darktable tag `Music|AC/DC` is `Music/AC|DC` in Immich. The reverse undoes it.
  - Write `TagsList` only where it already exists. Without it, Immich reads `HierarchicalSubject`, so the sidecars
    Darktable wrote need no change.
  - Leave out Darktable's own `darktable|…` tags.
- **F5. Rejects.** When Immich rewrites a rejected photo's sidecar (`-1` becomes `0`), put the reject back. `x:xmptk`
  tells who wrote last: exiftool means Immich or the daemon, Exiv2 means Darktable, whose un-reject stands.
- **F6. Ratings, descriptions, dates and GPS** are the same fields in both tools.
- **F7. Several accounts.** Each copy writes the whole sidecar from its own state. So an edit in one account can undo
  one made a minute earlier in another, before that copy re-read it.
  - Each copy, read through the API, is a source next to the sidecar.
  - Tags merge tag by tag. For the rating, title and description, the latest change wins.
- **F8. Trash.** Trashing or restoring one copy does the same to the others, with each owner's session. Emptying
  either trash deletes the file, and the other copies go offline.
  - **Offline looks like trash** (checked against 3.3.5): a library file that goes missing or is newly excluded gets
    `isOffline` and `deletedAt` (`library.service.ts`), and coming back clears both. The sync stream has no
    `isOffline`. How F8 tells the two apart is open (RESUME.md).
- **F9. Immich-only state, in the sidecar.** For each account: favorite, visibility (archived, locked) and album
  memberships (the album's ID and name).
  - Stored in a namespace of the daemon's own, keyed by account, and written when they change.
  - **Not mirrored between accounts:** they belong to each person.
  - Filing puts them back (section 7).
  - Writing a custom namespace needs an exiftool config that defines it. Check that Immich's sidecar writes and
    Darktable's (it keeps fields it doesn't own) both keep it.
- **F10. Named faces, in the sidecar.** For every named, visible person with a face in the photo (in any copy):
  - a `People|<name>` tag (`People/<name>` in Immich), so Darktable can filter by person;
  - an MWG face region (`mwg-rs:Regions`: the box and the name), the standard Lightroom, digiKam and Picasa use.
    Darktable keeps regions and transforms them on export, and Immich can read them. Filing uses them (section 7).

  How they're kept:
  - **One way, from Immich's faces:** when a face is renamed or removed, its tag and region go.
  - **Tags made by hand stay:** a `People|…` tag that was in the sidecar before the daemon derived it was made by
    hand, and is never removed. The state records which tags the daemon made.
  - **Videos get the tags only:** their faces come from a single frame.
  - **Immich's "import faces from metadata" (`metadata.faces.import`) must stay off.** With it on, every metadata
    refresh deletes and recreates the faces read from regions (`metadata.service.ts`, `applyTaggedFaces`), and the
    daemon refreshes often.
  - **Cost:** naming a person rewrites the sidecar of every photo they're in, and each rewrite syncs to every machine.
- **F11. Orphan sidecars.** A sidecar whose media file is gone is deleted, with these safeguards:
  - **Which file it belongs to:** a Darktable duplicate's sidecar (`<stem>_01.<ext>.xmp`) belongs to `<stem>.<ext>`,
    and a `<stem>.xmp` sidecar to any `<stem>.*`.
  - **Seen, then gone:** a sidecar is deleted only if the daemon saw its media file and then saw it go, at least the
    grace period (1 h) earlier. That covers a sidecar arriving before its video, and media a sync tool leaves out on
    this machine.
  - **Never seen:** orphans whose media file the daemon never saw are reported, not deleted.
  - **Conflict copies:** Syncthing conflict copies (`*.sync-conflict-*.xmp`) are reported, not deleted.

It writes only when a field actually has to change. Sidecars sync to every machine, and Darktable lists every changed
sidecar when it starts.

## 7. Filing (`Promote`)

**Sources:** the configured inbox subfolders.

**A unit is ready when** all of these hold:
- it's tagged `Promote` and has a title, after the merge;
- it isn't trashed in any copy, and isn't rejected;
- **it has settled:** every copy agrees with the sidecar, and nothing about the unit changed for the settle time.

**Why that's enough:**
- **A title and `Promote` added together** are both seen, because the merge runs first, in the same place.
- **The settle time is for Immich:** a sidecar write that Immich has queued but not yet done would otherwise land at
  the old path after the move.

**Without a title,** the unit stays put and gets `Promote/Needs a title`, which is cleared once it's filed.

**Naming,** exactly as the author's Darktable "Archive RAW" export preset does
(`$(EXIF_YEAR).$(EXIF_MONTH).$(EXIF_DAY) - $(TITLE)/$(EXIF_YEAR).$(EXIF_MONTH).$(EXIF_DAY)-$(EXIF_HOUR).$(EXIF_MINUTE).$(EXIF_SECOND) - $(CREATOR)`):
- **Paths:** photos go to `Pictures/YYYY.MM.DD - <Title>/YYYY.MM.DD-HH.MM.SS - <Creator>.<ext>`, with `_01`, `_02`, …
  on a collision. Videos go under `Videos/Clips/`.
- **Photos' date:** the sidecar's `exif:DateTimeOriginal` (which holds edits made in either tool), or else the file's
  own, as local wall time, as Darktable uses it.
- **Videos' date:** they have no `DateTimeOriginal`. Use Immich's `localDateTime`, or the QuickTime dates with their
  offset.
- **Extension:** kept as it is.

**Moving:**
- **The sidecar** moves with its file, renamed `<new name>.<ext>.xmp`.
- **A Live Photo's video** (Immich's `livePhotoVideoId`, or failing that the same base name) goes with its photo, into
  `Pictures`, under the photo's new base name.
- **`Promote` is removed** from the sidecar before the move, so the new asset arrives without it. The title stays.
- **Never overwrite, and never delete the source before the destination exists:** use `link()` then `unlink()`.
  Refuse to move between filesystems.
- **Plan a whole batch** before moving anything, so an interrupted run can be finished or undone on the next one.

**Putting back what Immich keeps per asset.** The ratings, tags, title, description, creator and Darktable's history
are in the sidecar, so they need nothing. The rest is restored once each account has its new copy:
- **Favorite, visibility and albums:** set on the new copy in the same account, from F9.
- **Faces:**
  1. Wait until the new copy's faces have been detected and recognized. After a time limit, report it and stop.
  2. Match the new copy's faces to the old copy's by overlap: an intersection over union above 0.5, as Immich's own
     detection uses (`person.service.ts`, `handleDetectFaces`). The old copy's faces come from the state, including
     deleted ones, which `AssetFacesV3` reports.
  3. Reassign a face whose person differs (`PUT /api/faces/{person}`, with the face's ID in the body: the API's
     order is the reverse of what its path suggests).
  4. Add a face that was added by hand and has no match (`POST /api/faces`).
  5. Delete a face that was deleted on the old copy (`DELETE /api/faces/{id}`, a soft delete, as in Immich's own
     interface).

  A person's ID in Immich 3.3's API is its person group's: the same in every account of a cluster group, where each
  account keeps its own record of the person, with its own name.

  An Immich server that mirrors face corrections between copies of the same file (the
  [kael-shipman/immich](https://github.com/kael-shipman/immich) fork does) needs the corrections applied to one copy
  only. Otherwise a face added by hand would be added twice. Configurable.
- **The old copies:** check that they end up offline or removed, using only calls that can't reach the disk.

## 8. Account upkeep

Applied from configuration at start and on every full pass. Every step is idempotent, and nothing here deletes a file
or a library.

- **Libraries:** each account's libraries, with their folders and exclusion patterns.
  - The daemon creates missing libraries, corrects exclusion patterns, and starts a scan when it changed something.
  - Creating a library for another account needs the admin's session, and every library call does too. A library's
    owner is set when it's created and never changes.
  - Two accounts' libraries can index the same folder, and each gets its own assets (checked against 3.3.5).
  - Immich allows at most 128 import paths and 128 exclusion patterns per library, each unique and non-empty. The
    daemon checks before sending, so the error names the library.
  - It never deletes a library. A library that's in Immich but not in the configuration is reported.
- **Libraries limited by date** (`since = "YYYY-MM-DD"`): the library sees only names that start with a date on or
  after `since`, at the configured levels (for example, the first folder level under `Pictures` and the second under
  `Videos`). Everything else is excluded: earlier dates, undated names, and names whose date is too vague (`2019` or
  `2019.07`, when `since` falls inside that year or month).
  - **The rule** (`src/core/folder-dates.ts`): a name is allowed when it starts with a year after `since`'s, or with
    `since`'s year and a later month, or with `since`'s month and a day on or after `since`'s. Dates are written
    `YYYY.MM.DD`, `YYYY-MM-DD` or `YYYYMMDD`. What follows the date doesn't matter.
  - **The exclusion patterns** (`src/core/exclusions.ts`) are generated from that rule: globs for every prefix that
    can't start an allowed name, each written `<level>/<prefix>{,/**}` so it covers the name and everything inside.
    About 44 per level; Immich allows at most 128 per library.
  - **Tested against the matchers Immich uses:** picomatch (its watcher, with `dot: true`, and its check of existing
    assets, with `nocase: true`) and fast-glob (its crawler, with the options it passes). The tests fuzz thousands of
    names around several cutover dates, and crawl a real folder tree.
  - **Negated brackets are written `[^…]`.** picomatch reads `[!…]` as a literal `!`, which would silently match the
    wrong names.
  - **Files directly in a folder above a dated level** (`Videos/loose.mp4`, when the level is `Videos/*`) aren't under
    any dated name, so `Videos/*.*` excludes them. A folder there with a dot in its name would be excluded too, and
    the check would report its files as missing.
- **The check,** after every scan and on demand (`media-triage check`), classifies every indexed path with the same
  rule. It fails on:
  - any asset in a date-limited library that the rule doesn't allow;
  - any file the rule allows that isn't in that library.

  A failure is reported loudly, and the daemon changes nothing to fix it. It also reports the undated names, and inbox
  files dated before `since`.
- **Cluster group:** every configured account is in one cluster group (Immich 3.2).
  - An account that isn't gets invited from the first account's group, and accepts with its own session.
  - This happens **before that account's libraries are created**, so its faces cluster into the people that already
    exist.
  - Joining keeps people and names (`cluster-group.service.ts`, `acceptRequest`). The group's "Reset facial
    recognition" is what deletes every person and name; the daemon never calls it. Checked against 3.3.5: the
    joining account keeps its named people.
- **People:**
  - All people are shared between the accounts, both ways, with the write role, on every pass. Immich allows sharing
    only within a cluster group, so this comes after joining. "Share all" covers
    only the people that exist when it runs.
  - A name is copied onto the other accounts' unnamed records for the same person group, unless Immich already shows
    the sharer's name.

## 9. Safety

- **Dry run** (`--dry-run`) runs everything and writes nothing, with counts per rule and samples. Use it first, on
  everything.
- **It never deletes media.** The only files it deletes are orphan sidecars (F11). Deleting media is done through
  Immich's trash, and filing only moves files.
- **It writes only the fields that have to change.** exiftool runs with `-overwrite_original`, since its `*_original`
  backups would sync everywhere.
- **Immich only through its API,** never its database.
- **Test on copies,** never first on a real archive.

## 10. Code and packaging

- **TypeScript on [Bun](https://bun.sh), compiled into one executable per platform** (`bun build --compile`):
  `linux-x64` and `linux-arm64`.
  - SQLite (`bun:sqlite`) and TOML (`Bun.TOML`) are built in, so there's no native module to bundle.
  - Immich's API is reached through `@immich/sdk`, upstream's generated client, so API changes show up as type errors.
  - Sidecars are read and written with `exiftool-vendored`, the library Immich itself uses.
- **One outside dependency: exiftool,** a Perl program, run from the system's install (Debian's
  `libimage-exiftool-perl`). It could be bundled later, by extracting it on first run: Perl can't read files embedded
  in the executable.
- **Layout:**
  - `src/main.ts`: the command line;
  - `src/core/`: the pure rules, without I/O;
  - `src/immich/`: the Immich client: one `ImmichClient` per account's session, wrapping `@immich/sdk` (pinned to the
    server's version), plus the sessions and `login`, assets (`assets.ts`: listing, finding by path, and bulk
    changes), albums, faces and people (`albums.ts`, `faces.ts`, `people.ts`), libraries and users (`libraries.ts`), cluster
    groups (`cluster-groups.ts`), and the sync stream (`sync.ts`, read with `fetch`, since the
    SDK's `getSyncStream` reads the whole response as text);
  - each module's tests sit beside it (`*.test.ts`).
  - `test/immich/`: a development Immich for the integration tests (`compose.yml`, started and stopped by `dev.ts`),
    and what the tests share (`harness.ts`). Tests that need it are skipped unless `MEDIA_TRIAGE_IMMICH_TESTS=1`;
  - `test/fixtures/`: small media files with made-up metadata.
- **Run it on the host, not in a container,** or at least with the inbox and archive in one mount. Filing moves files
  with `link()`, which fails across mounts (`EXDEV`), even between two bind mounts of the same drive.
- **Releases:** pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`. It tests, builds both executables, writes
  `SHA256SUMS`, and publishes a GitHub release. A tag with a hyphen (`v1.2.0-rc.1`) makes a pre-release.

## 11. Upgrades

```toml
[upgrade]
enabled = true                                         # check for and install new releases by itself
repo = "https://github.com/kael-shipman/media-triage"  # where releases come from (GitHub or GitHub Enterprise)
interval = "6h"                                        # how often to check
track = "minor"                                        # how far an automatic upgrade may go: "patch", "minor" or "major"
prerelease = false                                     # also take pre-releases
restart = true                                         # exit after upgrading, so the service manager starts the new version
```

- **The daemon checks** one minute after it starts, then every `interval`, but only between passes, never in the
  middle of filing.
- **`media-triage upgrade`** checks and installs now, and `--check` only reports. `--to vX.Y.Z` installs a given
  version, even an older one; that's the only way to downgrade.
- **`track`:**
  - `patch` takes only `X.Y.*`;
  - `minor` takes anything within the same major version (the default, as major versions may need changes to the
    configuration);
  - `major` takes anything newer.
- **How it upgrades:**
  1. List the repository's releases (`GET /repos/{owner}/{repo}/releases`), and pick the newest version `track` and
     `prerelease` allow.
  2. Download `media-triage-<os>-<arch>` and `SHA256SUMS` from it, and check the hash.
  3. Write the new executable next to the running one, and run it with `version` to check that it starts and reports
     the expected version.
  4. Rename it over the running executable (an atomic swap, in the same folder).
  5. With `restart`, exit with status 75, which the installer's systemd unit restarts on. Without it, the new version
     runs from the next start.
- **The executable must be writable** by the user the daemon runs as. The installer puts it in `~/.local/bin` for that
  reason. If it isn't writable, the check logs it and skips.
- **Running from source** (`bun src/main.ts`) never upgrades.

## 12. The installer

[install.sh](../install.sh), a POSIX shell script:

```sh
curl -fsSL https://raw.githubusercontent.com/kael-shipman/media-triage/main/install.sh | sh -s -- [options]
```

| Option | Default | What it does |
|---|---|---|
| `--version vX.Y.Z` | the newest release | The version to install |
| `--prefix DIR` | `~/.local/bin` | Where the executable goes |
| `--repo URL` | this repository | Where releases come from |
| `--service none\|user\|system` | `none` | Install a systemd unit: a user unit, or a system unit (needs sudo) that runs as you |
| `--prerelease` | off | Allow a pre-release when picking the newest |

- **It downloads and checks the executable,** as an upgrade does (hash, then `version`), and installs it.
- **It writes a starter configuration** (`media-triage init`) if there's none. It never overwrites an existing one.
- **With `--service`,** it writes a unit that restarts the daemon after an upgrade (`Restart=always`), and enables it.
  A user unit also needs `loginctl enable-linger` to run without a login session; the installer says so.
- **It warns if exiftool is missing.**
- **Re-running it is safe:** it reinstalls or upgrades the executable and leaves the configuration alone.

## 13. Scale

An archive can hold tens of thousands of photos and videos, each with a sidecar, and each shared one is an asset in
several accounts. On a typical day almost none of it changes. So, apart from the first run, the daemon's work grows
with what changed, not with the size of the archive.

- **Files:** inotify reports changes as they happen. The full pass only stats files, and compares each sidecar's size
  and mtime with the state's record. It reads a sidecar, the slow part, only when it changed.
- **exiftool** runs as one long-lived process (`-stay_open`, managed by `exiftool-vendored`), never a process per
  file.
- **Immich's changes** come from the sync stream, which sends only what changed since the last acknowledgement. The
  stream is read line by line as it arrives, never held in memory whole, and acted on in batches.
- **Asset paths** (section 3) are looked up in bulk when there are many: on a first run, after a reset, or when one
  batch from the stream holds many new assets (a new library's first scan). Then each of their libraries is listed with
  a search (`POST /api/search/metadata`, filtered by library), a page of 1,000 at a time. A few new assets are looked
  up one by one (`GET /api/assets/{id}`).
- **Writes to Immich are batched:** metadata refreshes (`POST /api/assets/jobs`), trashing (`DELETE /api/assets`),
  restoring (`POST /api/trash/restore/assets`), and favorites and visibility (`PUT /api/assets`) each take a list of
  assets. A change to a thousand photos is a few requests, not a thousand.
- **The state database** is indexed by path and by asset ID, and each batch's writes are one transaction.
- **inotify needs a watch per folder.** At start, the daemon compares the number of folders with
  `fs.inotify.max_user_watches`, and says how to raise it if it's too low. Other programs, such as Syncthing, use
  watches from the same allowance.
- **The first run is the heaviest:** it reads every sidecar once, and streams every asset once per account. Run it with
  `--dry-run` first, which shows what it would do, with counts.

## History

- 2026-11-03: written, from the plan made for the author's own setup.
- 2026-11-04: sync covers the whole archive, not just the inbox (section 1), and section 13 (scale) added. Section 3
  corrected from Immich 3.3.5's source: `AssetsV2` and `AlbumsV2` instead of the V1 types, the stream carries no
  paths, `AssetFacesV3` covers the cluster group, and resets.
