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

**The covered folders** are the folders of every configured library (`[[immich.libraries]]`, mapped to local paths
through `path_map`), plus the inbox's sources. That's what the daemon watches and passes over. `paths.archive` is only
where filing puts files: it can be the root of a larger tree (setup files, backups) with nothing to sync, which isn't
watched.

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
| `[paths]` | The inbox, the archive (where filing puts files), and the state folder |
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

1. **Files:** inotify on the covered folders (section 1), with a watch per folder. It sees files arriving from the
   phones, Darktable's sidecars, and Immich's sidecar writes. A full pass over the same folders at start, and then
   daily, catches anything missed (`src/sync/`).
   - A unit is a media file Immich indexes and its `<file>.<ext>.xmp`, the one name Darktable reads. Other sidecar
     names (`<stem>.xmp`, a Darktable duplicate's `<stem>_01.<ext>.xmp`), hidden and temporary files, and Syncthing's
     conflict copies aren't synced. A sidecar named like a duplicate's is one only if no media file has its name and
     one has the name without the number: a Pixel's `PXL_20261031_212120738.jpg`, a camera's `DSC_0001.NEF` and a
     filed `…_01.jpg` end the same way. (Before 2026-11-07 the watcher ignored their sidecars' changes, which only the
     daily full pass then found.)
   - A link to a file is a media file, as Immich's library scan follows links. The full pass doesn't enter a linked
     folder: Immich does, but the daemon doesn't apply a library's exclusion patterns, and a linked folder is often
     an excluded one (`Best-Of Photos`). Before 2026-11-07 the full pass skipped linked files too, so their sidecars
     were reported as orphans.
   - Bun's recursive `fs.watch` watches every folder, new ones included, with one inotify instance. Changes are acted
     on once a unit has been quiet for a moment, since a sidecar can be written in several steps.
2. **Immich, per account: its sync stream** (`POST /api/sync/stream`), the feed of changes the phone apps use. It
   asks for these types, all current in Immich 3.3 (which refuses `AssetsV1`: `sync.service.ts`, `syncAssetsV1`):
   - `AssetsV2`: trash (`deletedAt`), `isFavorite`, `visibility` (archived, locked), the library, the Live Photo's
     video;
   - `AssetExifsV1`: rating, description, dates;
   - `AlbumsV2` and `AlbumToAssetsV1`: albums and their assets. An `AlbumDeleteV1` means the account no longer sees
     the album: it was deleted, or the account lost access (`album_user_delete_audit`). So the state keeps albums and
     their assets per account;
   - `PeopleV1` and `AssetFacesV3`: people and their names, and each face's person, box, source and deletion.
     `AssetFacesV3` covers every asset in the account's cluster group, so once the accounts share a group, each
     account's stream also reports the faces on the other accounts' copies.

   **No paths:** an asset in the stream has its file name but not its path. The daemon looks up the path of each
   asset it hasn't seen before, and keeps every asset's ID and path in its state. Each asset is recorded with its
   owner's account, whose session changes it: album events can name other users' assets (in an album shared with the
   account), and those are left to their own account's stream. A library asset's path never changes,
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
   reads the whole account again as on a first run, and logs it. What the account's stream reported before (its
   albums and people, and the cluster group's faces) is kept, marked stale, until the stream sends it again; once the stream has been read whole, what's still
   stale is gone, and its units are reconciled. Emptying it at the reset would rewrite those sidecars twice.

   **Late, never lost** (seen in testing, 2026-11-04): a change can reach the stream a moment after Immich's API call
   returns. A stream read at once can miss it, and a read 2 seconds later has it. The daemon reads every minute.

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
- **Using them** (`src/upkeep/accounts.ts`): each pass opens every configured account's session and checks it
  (`GET /api/users/me`). An account that isn't logged in, whose session file others can read, whose session was
  revoked or expired, or whose session belongs to another email is skipped, with what to do. Immich being unreachable
  stops the pass instead, to be tried again at the next one.
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

**How it's built** (`src/sync/reconcile.ts`, `src/core/merge.ts`):
- **The sides** are Darktable's view of the sidecar (`darktableReads`) and each copy, read through the API
  (`getAsset`). Immich's view of the sidecar isn't a side: it's what some copy wrote, and that copy is one. Each value
  is compared in one form: tags in Immich's notation with the title as its tag, no rating or an empty description as
  null, dates by wall time.
- **The base** is the unit's last-synced record. Tags merge tag by tag against it; the rating, description, date and
  GPS go to the latest change (a side that differs from the base, the latest by the sidecar's mtime or the asset's
  `updatedAt`); trash follows a copy that isn't offline (F8).
- **Each copy is also compared with what it said itself at the last sync** (the record keeps every copy's values,
  `SyncedValues.seen`). A value a copy still holds isn't a change, even where the merge went another way: it removes
  only a tag it held then, and adds only one it didn't. Otherwise a copy that keeps an older value would undo the
  sidecar's, over and over (found checking the first run on real files, 2026-11-05; `src/sync/first-contact.test.ts`):
  - **a sidecar Immich doesn't know** (F1: made after Immich indexed the photo, by Darktable or by F2): a refresh
    doesn't read it but still updates the asset, so the copy seemed to have caught up, and its missing tags, title
    and rating read as removals, and were deleted from the sidecar;
  - **a reject** (`xmp:Rating` -1), which Immich reads as unrated: the copy's "no rating" cleared it.

  A copy the last sync didn't see (a new account's library, a copy learned late) proposes nothing at all, its trash
  included: it takes the unit's state. Otherwise a new account's copy of a photo in the trash, itself not trashed,
  read as a restore, and took the photo out of the trash for everyone.
- **The image file's own metadata shows in Immich where the sidecar lacks a field.** Immich reads the image, then lays
  the sidecar's fields over it, field by field (`metadata.service.ts`, `getExifTags`). So an older JPEG that embeds a
  `TagsList` (written by another program, years ago) shows that list in Immich, over Darktable's
  `HierarchicalSubject`, and a photo with no capture time in the image or the sidecar shows the file's own time
  (`getDates`). The daemon reads the image's tag fields and capture time (`Exiftool.readImage`, cached by the file's
  size and mtime) on first contact, where the sidecar has no `TagsList`, and where it has no date:
  - **On first contact, a tag a copy holds only because the image embeds it isn't an addition.** An edit in Immich
    writes `TagsList` to the sidecar, so those tags come from the image, and Darktable read the same tags from it at
    import: the sidecar decides them. Otherwise the union would bring back into Darktable every embedded tag since
    reorganized there. Found in the first dry run on the author's archive (2026-11-07): about 900 photos would have
    regained `People|Family|<name>` tags moved in Darktable years before.
  - **`TagsList` is written where Immich would show the image's tags** (F4).
  - **Without a date in the sidecar or the image, a copy's date isn't a side:** it's the file's time, not a capture
    time. Found in the same dry run: 16 archive photos and 147 inbox files would have been given their file's time
    as a capture time. Filing still dates such a unit by Immich's (section 7).
- **Without a base** (the first sync, or a lost state): the union of tags, which never drops one, and for the rating,
  description, date and GPS, the sidecar's value, or the latest copy's where the sidecar has none. Every edit made in
  Immich is written to the sidecar, so a copy that differs from it hasn't read it: on the first run, a change made in
  Darktable that Immich never read would otherwise lose to Immich's older value, whenever anything else had updated
  the asset since (a favorite, a job). A description is compared without the spaces around it, as Immich reads it.
- **Telling Immich:** when the sidecar is written, every copy is refreshed; otherwise only copies that don't hold what
  they'd read from the sidecar (`immichReads`), such as another account's copy after an edit in Immich. Refreshes,
  trashes and restores are batched per account.
- **A copy catching up isn't a side.** Until a copy asked to refresh has read the sidecar, what it says of the
  sidecar's values is an older sidecar's. Counted as a side, it would undo the change it was asked to read: the daemon
  looks at the unit again a moment after its own write (the watcher sees it), and a tag just removed, still on the
  copy, would read as one the copy added (found in testing, 2026-11-04). So until it catches up, only its trash
  counts. It has caught up once it holds what it would read from the sidecar it was asked to read, or from the sidecar
  now (an edit in Immich rewrites the sidecar), or once its `updatedAt` changed at least 2 seconds earlier (metadata
  extraction updates the asset; its tags are replaced in a parallel step). After an hour it counts again, with a
  warning. A copy catching up is asked again if the sidecar has changed since it was asked. This is kept in memory: a
  restart forgets it.
- **A copy the last sync didn't see isn't a side either,** once there's a base, until it holds what the sidecar says
  (and it's asked to refresh). It may have read an older sidecar: a tag it never had, such as the title tag written
  before this account's copy was learned, would read as one it removed (found by the daemon's smoke test,
  2026-11-04). The unit's record keeps which copies it read. Without a base, every copy is a side, so the union never
  drops a tag.
- **Not yet:** removing GPS or a date (a side that drops one isn't acted on, so nothing is lost).
- **A unit whose media file is gone** isn't reconciled: its record notes when it was seen gone (F11).
- **In the daemon** (`src/sync/job.ts`): the full pass at start and daily; the `sync` job each minute and after every
  change the watcher sees, reading each account's stream (a batch is reconciled before it's acknowledged), then up to
  200 units that have been quiet for 2 seconds, so a first run over the whole archive doesn't hold up other jobs.
  Without exiftool, the daemon stops, saying how to install it.
- **A dry run** reads and merges, logs what it would write (the first 20 sidecars of each batch), and writes, records
  and acknowledges nothing. Its warnings and errors go to stderr, so capture both (`2>&1`). It reads each stream once
  per start, since unacknowledged streams would otherwise be read whole each minute.

## 6. Sync rules

- **F1. Refresh.** Any sidecar that changed, for any reason, leads to a metadata refresh of every copy with that path,
  in each account, batched. Immich never notices a sidecar-only change by itself: its watcher and scans look only at
  media files.
  - **A refresh re-reads only a sidecar Immich already knows** (checked against 3.3.5). It looks for sidecars when it
    first indexes a file (`SidecarCheck`), and `refresh-metadata` doesn't look again (`asset.service.ts`, `run`), so
    a sidecar that appeared later, such as one made by F2 just after Immich indexed the photo, isn't read.
  - **Fixed in the server, not worked around here** (decided 2026-11-04): the author's fork
    ([kael-shipman/immich](https://github.com/kael-shipman/immich)) gets a small change so that `refresh-metadata`
    looks for a sidecar first (it queues `SidecarCheck`, whose follow-up job is the extraction), a fix upstream could
    take too. The setting `immich.reads_new_sidecars` says whether the server has it. On a server without it, the
    daemon still refreshes, sidecars that appeared after indexing stay unread there, and it warns when it makes one
    (F2).
- **F2. Creator.** A file in an inbox source with no `dc:creator` gets the source's creator. An existing creator is
  never overwritten. Most new photos have no sidecar yet, so create a minimal `<file>.<ext>.xmp`, the name both tools
  look for first. It's written under a hidden temporary name and linked into place, which fails if a sidecar appeared
  in the meantime, so it never replaces one (`src/sidecars/sidecar.ts`, `createSidecar`).
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
  - Write `TagsList` where it already exists, and where there's a title: Immich's tags hold the title as a tag (F3),
    which Darktable's fields don't, and without `TagsList` Immich reads `HierarchicalSubject`. Also where the image
    file embeds tags Immich would show instead (section 5): a `TagsList`, or any tags when the sidecar has none.
    Otherwise the sidecars Darktable wrote need no change. Not handled: an image whose embedded tags Darktable's
    fields don't hold at all, since an empty `TagsList` can't be written; Immich keeps showing them.
  - Leave out Darktable's own `darktable|…` tags. Immich reads them too when there's no `TagsList`, and shows
    `darktable/format/jpg`, so they're left out on both sides. They're never added or removed in any field: a write
    keeps the ones each field had.
- **F5. Rejects: not handled** (decided 2026-11-04). Immich reads a sidecar's `-1` as unrated, and writes `0` the next
  time it rewrites the sidecar. That doesn't matter in practice: the author triages in one tool at a time, deletes the
  photos rejected in Darktable right after triaging, and Immich has no background job that rewrites sidecars meanwhile.
- **F6. Ratings, descriptions, dates and GPS** are the same in both tools, with two copies Immich keeps for itself
  (checked against 3.3.5):
  - **Immich writes each value twice and reads its own copy first.** With MWG on, its sidecar write puts the
    description in `dc:description` and `tiff:ImageDescription`, and the date in `exif:DateTimeOriginal` and
    `photoshop:DateCreated`. It reads `ImageDescription` before `Description`, and the date from MWG, which in a
    sidecar is `photoshop:DateCreated` (`metadata.service.ts`). Darktable reads and writes only `dc:description` and
    `exif:DateTimeOriginal`, so after Immich has written a sidecar, Darktable's edits to those two don't reach Immich.
    So the daemon writes both copies, but Immich's copy of the description only where it already exists, as with
    `TagsList` (F4). Dates follow the rules below.
  - **Darktable has no time zones, on purpose** (checked in 5.6.1's source). It drops a date's offset when it reads
    one (`datetime.c`, `dt_datetime_exif_to_numbers`), writes dates without, and never reads EXIF's
    `OffsetTimeOriginal`. It reads `exif:DateTimeOriginal`, or `photoshop:DateCreated` without it, and keeps the
    second when it rewrites a sidecar. Its geotagging module's "apply offset" adds the offset to each photo's time and
    stores the result: no offset is stored per photo.
  - **So `photoshop:DateCreated` holds the capture time with its zone** (decided by the author, 2026-11-04: both tools
    must always show the same capture time, and get the zoned one). The rules (`src/core/xmp.ts`, `planWrite`):
    - **A date without an offset takes one:** the sidecar's (`photoshop:DateCreated`'s, then
      `exif:DateTimeOriginal`'s), since a time set in Darktable has none and the zone didn't change; or else one known
      from Immich (`offsetFromImmich`: its `localDateTime` minus `fileCreatedAt`, when it knows the zone).
    - **`photoshop:DateCreated` is written whenever it differs,** by wall time or offset, and added where it's missing
      only to keep an offset that `exif:DateTimeOriginal` doesn't hold.
    - **`exif:DateTimeOriginal` is written when its wall time changes, or along with Immich's field.** An offset
      Darktable dropped isn't a reason to write: Darktable would drop it again, and list the sidecar as changed each
      time it starts.
    - So a time changed in Darktable (by hand, or by its offset) reaches Immich with the zone it had, and both show
      the same wall time. `src/sidecars/writers.test.ts` checks it with Darktable itself, along with the next Darktable
      write needing nothing more.
  - Dates are compared by wall time, to the second (Darktable keeps milliseconds, but shows seconds).
  - Ratings are `xmp:Rating` and GPS is `exif:GPSLatitude` and `exif:GPSLongitude` in both. Immich reads only ratings
    1 to 5 (F5).
- **F7. Several accounts.** Each copy writes the whole sidecar from its own state. So an edit in one account can undo
  one made a minute earlier in another, before that copy re-read it.
  - Each copy, read through the API, is a source next to the sidecar.
  - Tags merge tag by tag. For the rating, title and description, the latest change wins.
  - A copy's change is what differs from what that copy said at the last sync (section 5), so both of two edits made
    a minute apart in two accounts stay, though the second copy's sidecar write left out the first's tag.
- **F8. Trash.** Trashing or restoring one copy does the same to the others, with each owner's session. Emptying
  either trash deletes the file, and the other copies go offline.
  - **Offline looks like trash** (checked against 3.3.5): a library file that goes missing or is newly excluded gets
    `isOffline` and `deletedAt` (`library.service.ts`), and coming back clears both. The sync stream has no
    `isOffline`.
  - **So only a real trash or restore is mirrored** (decided 2026-11-04): before mirroring one, the daemon reads the
    copy it happened to through the API, and mirrors it only if that copy isn't offline. Going offline and coming back
    online are never mirrored. Otherwise a change to one account's exclusion patterns would trash the other accounts'
    online copies, and emptying their trash 30 days later would delete the files.
- **F9. Immich-only state, in the sidecar.** For each account: favorite, visibility (archived, locked) and album
  memberships (the album's ID and name).
  - Stored in a namespace of the daemon's own (`mediatriage`,
    `https://github.com/kael-shipman/media-triage/ns/1.0/`), in one field, `mediatriage:Accounts`: a list with an entry
    per account (`User`, `Favorite`, `Visibility`, and `Albums`, each with `Id` and `Name`). `src/sidecars/namespace.ts`
    shows its shape.
  - **Keyed by the account's Immich user ID,** which never changes, and belongs to the same server as the album IDs.
    The configuration's account names are only labels.
  - **Written when they change, and only what isn't the default:** an account with nothing to record has no entry, and
    an entry leaves out `Favorite` when false, `Visibility` when "timeline", and `Albums` when there are none. So most
    sidecars never get the field, and the first pass over the archive doesn't rewrite them all.
  - **Not mirrored between accounts:** they belong to each person.
  - **Where they come from** (`src/sync/reconcile.ts`, `accountStates`): each copy read through the API, with the
    albums the state holds it in, from the account's stream (an album rename or a lost album reconciles every unit in
    it). A locked copy, which Immich won't show without the account's PIN, goes by what the stream last said; locking
    also takes it out of every album (`asset.service.ts`). An account with no copy to go by (its session isn't open,
    or the copy is gone) keeps its entry as it is. `hidden` isn't recorded: Immich gives it to a Live Photo's video.
  - **Written only where there's a sidecar,** like every other field: in the archive, a photo with no sidecar doesn't
    get one for its favorite.
  - Filing puts them back (section 7).
  - Writing a custom namespace needs an exiftool config that defines it, which the daemon writes to a temporary folder
    and passes to exiftool. **Checked: Immich and Darktable both keep it** when they rewrite a sidecar (Immich 3.3.5
    with its own exiftool, which doesn't know the namespace; Darktable 5.6.1, which reads and keeps every field it
    doesn't own). `src/sidecars/writers.test.ts` checks both, along with face regions.
- **F10. Named faces, in the sidecar.** For every named, visible person with a face in the photo (in any copy):
  - a `People|<name>` tag (`People/<name>` in Immich), so Darktable can filter by person;
  - an MWG face region (`mwg-rs:Regions`: the box and the name), the standard Lightroom, digiKam and Picasa use.
    Darktable keeps regions and transforms them on export, and Immich can read them. Filing uses them (section 7).
  - **Coordinates** (`src/core/regions.ts`): a region is its centre and size as fractions of the image as stored,
    before the EXIF orientation is applied. Immich's faces are boxes in pixels of the image as shown. Immich reads a
    region by rotating it with the orientation (`metadata.service.ts`, `orientRegionInfo`), so a region made from a face
    undoes that, using the orientation Immich used (the asset's `exifInfo.orientation`). The tests check, for all eight
    orientations, that Immich's own reading gives back the face. `AppliedToDimensions` is the size Immich measured the
    face in, turned back to the stored image's way round.
  - **Other tools' regions are kept:** a region is written back with every field it was read with, including shapes
    other than rectangles.

  How they're kept:
  - **One way, from Immich's faces:** when a face is renamed or removed, its tag and region go.
  - **Tags made by hand stay:** a `People|…` tag that was in the sidecar before the daemon derived it was made by
    hand, and is never removed. The state records which tags the daemon made.
  - **Videos get the tags only:** their faces come from a single frame.
  - **Immich's "import faces from metadata" (`metadata.faces.import`) must stay off.** With it on, every metadata
    refresh deletes and recreates the faces read from regions (`metadata.service.ts`, `applyTaggedFaces`), and the
    daemon refreshes often.
  - **Cost:** naming a person rewrites the sidecar of every photo they're in, and each rewrite syncs to every machine.

  How it's built (`src/core/faces.ts`; `namedFaces` in `src/sync/reconcile.ts`):
  - **From the state, not the API:** `GET /api/assets/{id}` lists an asset's people but not their faces' boxes. So the
    state keeps every face the streams report (`AssetFaceV3`, the whole cluster group's: the person group's ID, the
    box, `isVisible`, `deletedAt`) and each account's own record of each person (`PersonV1`: its name and `isHidden`).
    Filing needs the old copy's faces from the state anyway (section 7). A new face, a rename, hiding or showing a
    person, or a deleted person reconciles every unit with a face of theirs.
  - **Who counts:** a face that's visible and not deleted, whose person the copy's account names and doesn't hide.
    Each person's faces come from the first copy that has them, so copies sharing their faces (the fork's twins) don't
    double the regions.
  - **The tag** is `People/<name>`, with a `/` in the name written `|` (F4's translation), so it doesn't nest.
  - **The daemon's regions** are told from other tools' by the state (each one's name and area), and made again from
    the faces each time; other tools' are kept as they were read.
  - **Left alone:** a unit with no copy the state knows, and a unit without a sidecar.
- **F11. Orphan sidecars.** A sidecar whose media file is gone is deleted, with these safeguards:
  - **Which file it belongs to:** a Darktable duplicate's sidecar (`<stem>_01.<ext>.xmp`) belongs to `<stem>.<ext>`,
    and a `<stem>.xmp` sidecar to any `<stem>.*`.
  - **Seen, then gone:** a sidecar is deleted only if the daemon saw its media file and then saw it go, at least the
    grace period (1 h) earlier. That covers a sidecar arriving before its video, and media a sync tool leaves out on
    this machine.
  - **Never seen:** orphans whose media file the daemon never saw are reported, not deleted.
  - **Conflict copies:** Syncthing conflict copies (`*.sync-conflict-*.xmp`) are reported, not deleted.

  How it's built (`src/sync/orphans.ts`, `src/sync/full-pass.ts`):
  - **Seen** means the unit has a record: the daemon reconciled its media file at least once.
  - **Seeing it go:** the reconcile finds the media file missing (the watcher reports its deletion), or a full pass
    finds its sidecar with no media file beside it. Either notes the time in the unit's record (`gone`), once. A media
    file that comes back is reconciled again, which clears it.
  - **Deleting:** each full pass (at start and daily) lists the orphans, and deletes those whose media file was seen
    gone at least the grace period (`timing.orphan_grace`) earlier, after listing the folder again. The unit's record
    goes with it. So a sidecar goes at the first full pass after the grace period, which can be a day later.
  - **A dry run** reports what it would delete, and notes nothing.

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

**Without a title,** the unit stays put and gets `Promote/Needs a title`, which is cleared once it's filed, or once
`Promote` is gone.

**How readiness is judged** (`src/core/filing.ts`, `readiness`; the reconcile reports it): "rejected" is Darktable's
reject (`xmp:Rating` -1); a copy agrees with the sidecar when it holds what it would read from it and isn't catching
up (section 5); the unit last changed at the latest of the sidecar's mtime and the copies' `updatedAt`. A unit with a
copy in an account whose session isn't open isn't filed: that copy's state can't be read.

**Naming,** exactly as the author's Darktable "Archive RAW" export preset does
(`$(EXIF_YEAR).$(EXIF_MONTH).$(EXIF_DAY) - $(TITLE)/$(EXIF_YEAR).$(EXIF_MONTH).$(EXIF_DAY)-$(EXIF_HOUR).$(EXIF_MINUTE).$(EXIF_SECOND) - $(CREATOR)`):
- **Paths:** photos go to `Pictures/YYYY.MM.DD - <Title>/YYYY.MM.DD-HH.MM.SS - <Creator>.<ext>`, with `_01`, `_02`, …
  on a collision. Videos go under `Videos/Clips/`.
- **Photos' date:** the sidecar's `exif:DateTimeOriginal` (which holds edits made in either tool), or else the file's
  own, as local wall time, as Darktable uses it.
- **Videos' date:** they have no `DateTimeOriginal`. Use Immich's `localDateTime`, or the QuickTime dates with their
  offset.
- **Extension:** kept as it is.
- **Not filed, and reported:** a unit with no capture time, and a unit whose archive folder is on another filesystem.
  (`src/filing/plan.ts`)

**Moving:**
- **The sidecar** moves with its file, renamed `<new name>.<ext>.xmp`.
- **Darktable's duplicates** (their sidecars, `<stem>_01.<ext>.xmp` and so on: a duplicate has no file of its own) move
  with their photo and keep their numbers: `<new name>_01.<ext>.xmp`. A name like a duplicate's is one only if no media
  file has that name: a photo can be called `<stem>_01.<ext>`. The unit's collision number is one at which the
  duplicates' new names, as files and as sidecars, are free too, since `<new name>_01.<ext>.xmp` would otherwise be the
  sidecar of a photo filed earlier as `<new name>_01.<ext>`. (Decided by the author, 2026-11-07; before, such a photo
  wasn't filed.)
- **A Live Photo's video** (Immich's `livePhotoVideoId`, or failing that the same base name) goes with its photo, into
  `Pictures`, under the photo's new base name.
- **`Promote` is removed** from the sidecar, and from the duplicates', before the move, so the new asset arrives
  without it. The title stays.
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

**How it's put back** (`src/filing/restore.ts`, each run of the filing job, for each unit being put back):
- **The new copies** are found by their path, in each account that had an old copy. One that's missing is waited for,
  until Immich's library queue is idle and 2 minutes have passed since the move: an account's libraries may leave the
  new path out (a date limit), and then its state can't be put back, which is reported.
- **Faces first,** since waiting for them is what takes time: while the old copy had detected faces that have no match
  on the new copy, or a match with no person yet, it waits (`src/core/face-match.ts`, `awaitingDetection`). Then
  `faceActions`: reassign, add the hand-made faces, delete the deleted ones; a detected face with no match is
  reported. The old copy's faces are its own account's, from the state.
- **Favorite, visibility and albums** from the sidecar's `mediatriage:Accounts`, each on the new copy in the account
  of that user ID. A locked visibility may need the account's PIN; if Immich refuses, it's reported.
- **Every step looks first,** so running it again changes nothing that's already so.
- **The old copies** must then be offline or gone (`getAsset`).
- **Waiting is limited** to an hour after the move. Then it does what it can, and reports the rest. Either way the
  unit is then released from the hold.

**Holding the unit** (decided with the author, 2026-11-04): the new copies arrive with default favorites, visibility
and albums, and no faces until Immich detects them. Sync would record those in the sidecar over what filing is about
to put back, and remove the named faces' tags and regions. So while a unit is being put back, the reconcile leaves its
per-account state (F9) and its named faces' tags and regions (F10) as they are, and goes back to normal once filing is
done with it.

**How it runs** (`src/filing/`): a unit becomes ready only once it has been left alone for the settle time, and
nothing else happens then to wake the daemon. So filing is a job of its own, every minute (sooner when a unit is only
waiting out the settle time): it reconciles the inbox units tagged `Promote`, then files those that are ready
(`fileBatch`):
- **The batch is planned, and the plans recorded** (the `filings` table), before anything moves.
- **Each unit, in turn:** `Promote` (and `Promote/Needs a title`) out of its sidecar, written from the sidecar as it
  was when the unit was found ready, so a change since stops the move and the unit is looked at afresh; then every
  file linked at its new name, each checked to be this very file if the name exists; then the old names removed; then
  the unit's sync record moved to the new path, so the next merge has its base and F10 still knows what it made. Then
  the unit is being put back, and held (above).
- **A plan cut short** is finished on the next run (`finishPlanned`), each step made again only if it isn't done. One
  that meets a problem (a new name taken by another file, a file gone) stays planned for a person, and is tried again
  only when the daemon starts.
- **Immich is asked to scan** the libraries holding the old and new paths (with the admin's session), since it
  notices neither the new files nor the old ones going until a scan. Without the admin's session, it sees them at its
  next scheduled scan.
- **A dry run** logs what it would file, where, and moves nothing. It looks for `Promote` in the units a live run
  recorded, so a dry run on a fresh state files nothing: check the inbox's sidecars for `Promote` instead.

## 8. Account upkeep

Applied from configuration at start and on every full pass. Every step is idempotent, and nothing here deletes a file
or a library.

**In this order** (`src/upkeep/upkeep.ts`): open the accounts, bring them into one cluster group, set up the
libraries (starting scans where something changed), then share and name people. A dry run (`--dry-run`) does every
step that only reads, and reports what the others would change.
- **If Immich can't be reached** (such as while it starts after a reboot), upkeep tries again in 5 minutes rather than
  at the next full pass.
- **The check is a job of its own,** run after each upkeep (and on every full pass), once Immich's library queue has
  been idle at two looks in a row, so it sees the result of any scan upkeep started. While the queue is busy it looks
  again each minute. Upkeep doesn't wait for scans: the daemon runs one job at a time, and waiting would hold up sync.

- **Libraries:** each account's libraries, with their folders and exclusion patterns.
  - The daemon creates missing libraries, corrects exclusion patterns, and starts a scan when it changed something.
  - **What it compares** (`src/core/libraries.ts`): libraries are matched by owner and name. A library's folders are
    its configured `folders`, and its exclusion patterns are Immich's own defaults for a new library (kept, so a
    library made in Immich's interface isn't changed for no reason), hidden files (`**/.*`, `**/.*/**`), the
    configured `exclude`, and the date limit's. Both are compared as sets, so their order never causes a change. Two
    libraries of one account with the same name are a problem to fix by hand, and nothing is done to them.
  - Creating a library for another account needs the admin's session, and every library call does too. A library's
    owner is set when it's created and never changes.
  - Two accounts' libraries can index the same folder, and each gets its own assets (checked against 3.3.5).
  - Immich allows at most 128 import paths and 128 exclusion patterns per library, each unique and non-empty. The
    daemon checks before sending, so the error names the library.
  - It never deletes a library. A library that's in Immich but not in the configuration is reported.
  - **Owners** are found by email in the admin's list of users, so libraries are matched even for an account that
    isn't logged in. Creating a library waits until its account is in the cluster group (below); correcting one needs
    only the admin, so a fix to its exclusions is never held up by a missing login.
  - **Scans** run in Immich's library queue. The check (below) waits until that queue is idle, polled until it's
    empty twice in a row.
- **Libraries limited by date** (`since = "YYYY-MM-DD"`): the library sees only names that start with a date on or
  after `since`, at the configured levels (for example, the first folder level under `Pictures` and the second under
  `Videos`). Everything else is excluded: earlier dates, undated names, and names whose date is too vague (`2020` or
  `2020.06`, when `since` falls inside that year or month).
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
    any dated name, so `Videos/*.*` excludes them. A folder there with a dot in its name (`Videos/My.Clips`) is not
    excluded: fast-glob doesn't prune it, and picomatch's `*` doesn't reach inside it (checked by the tests). Its
    entries are dated names like any other folder's.
- **The check,** after every scan and on demand (`media-triage check`), classifies every indexed path with the same
  rule. It fails on:
  - any asset in a date-limited library that the rule doesn't allow;
  - any file the rule allows that isn't in that library.

  A failure is reported loudly, and the daemon changes nothing to fix it. It also reports the undated names, and inbox
  files dated before `since`.

  How it works (`src/upkeep/check.ts`):
  - **Both directions use the rule** (`classifyPath`), not the exclusion patterns made from it, so a mistake in the
    patterns shows up.
  - **Every asset counts,** offline ones included: an asset that went offline is in the account's trash, where its
    thumbnail still shows. Locked assets can't be listed without the account's PIN, so they aren't checked.
  - **Files are found as Immich's crawler finds them** (fast-glob, its extensions and options, inside each folder),
    and the library's other exclusions are matched against Immich's paths, with the options Immich's watcher uses.
    Matching local paths instead would go wrong when the local folders are inside a hidden one (`~/.media/…`).
  - **Files changed since the library's last scan** (by ctime, which a move updates) are left for the next check.
  - **Nothing is assumed:** a library that doesn't exist yet, hasn't been scanned, belongs to an account that isn't
    logged in, or whose folders hold no media files here while Immich has some (a wrong path map) is a failure.
  - **Inbox files dated before `since`** are the owner's assets, in libraries whose folders are all in the inbox, with
    an Immich date (`localDateTime`) before it.
  - It needs the admin's session to find the libraries, and each owner's to list its assets. `media-triage check`
    prints the report and exits with 1 if anything failed or couldn't be checked.
- **Cluster group:** every configured account is in one cluster group (Immich 3.2).
  - An account that isn't gets invited from the first account's group, and accepts with its own session.
  - This happens **before that account's libraries are created**, so its faces cluster into the people that already
    exist. An account that isn't in the group by the end of this step (the first account isn't logged in, or joining
    failed) gets none of its libraries created in that pass.
  - Joining keeps people and names (`cluster-group.service.ts`, `acceptRequest`). The group's "Reset facial
    recognition" is what deletes every person and name; the daemon never calls it. Checked against 3.3.5: the
    joining account keeps its named people.
- **People:**
  - All people are shared between the accounts, both ways, with the write role, on every pass. Immich allows sharing
    only within a cluster group, so this comes after joining. "Share all" covers
    only the people that exist when it runs.
  - A name is copied onto the other accounts' unnamed records for the same person group. Immich 3.3 shows each account
    only its own record's name (the web lists the others' only as alternatives on the person's page, and the phone app
    not at all), so an unnamed record shows as unnamed there.
  - **Immich keeps names in step itself once people are shared** (checked against 3.3.5): renaming a person renames
    the records of the accounts that shared it with you with write access (`person.service.ts`, `update`), and a
    record made for a shared person starts with the sharer's name. So copying matters for records that existed,
    unnamed, before the name was set or shared: mostly the first pass after the accounts start sharing.
  - **Finding the unnamed records:** Immich's people list leaves out unnamed people with fewer faces than the
    recognition's minimum (3 by default), so each account's record of every person named elsewhere is read directly.
    A person named differently in different accounts is reported, and neither name is copied.

## 9. Safety

- **Dry run** (`--dry-run`) runs everything and writes nothing, with counts per rule and samples. Use it first, on
  everything.
- **It never deletes media.** The only files it deletes are orphan sidecars (F11). Deleting media is done through
  Immich's trash, and filing only moves files.
- **It writes only the fields that have to change.** exiftool runs with `-overwrite_original`, since its `*_original`
  backups would sync everywhere. It writes a new file and renames it over the old one, keeping the old one's
  permissions.
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
  - **A release uses only the exiftool on the PATH,** and says how to install it when there's none. It never falls back
    to the copy exiftool-vendored brings: a compiled executable would find that copy by the path it had on the machine
    that built it, so it would work there and nowhere else. Running from source, that copy stands in when the system
    has none (`src/sidecars/exiftool.ts`).
  - **One exiftool process** (`maxProcs: 1`), started after a one-off `exiftool -ver`, since exiftool-vendored retries
    starting a missing or broken exiftool without end.
  - **Fields by their group-qualified names** (`XMP-dc:Title`), without MWG's composite tags, so the daemon controls
    exactly which fields it reads and writes (`src/core/xmp.ts`).
  - **Text that looks like a number stays as written.** exiftool's JSON leaves out the quotes around such values (a
    title "1.50" would read as 1.5), so the daemon reads each number as the text exiftool printed. exiftool 12.76
    (Ubuntu 24.04's) ignores the option that would quote them.
  - **Checked with** exiftool 12.76 and 13.59 (the copy exiftool-vendored 35.21 brings, the same as Immich 3.3.5's).
    Debian 13 has 13.25. CI installs Ubuntu's and checks that the executable uses it.
  - **`media-triage sidecar FILE`** prints what the daemon reads from a sidecar (or from `FILE.xmp`), and what Immich
    and Darktable each read from it, as JSON. It needs no configuration.
- **Layout:**
  - `src/main.ts`: the command line;
  - `src/core/`: the pure rules, without I/O, including a sidecar's fields and what each tool reads from them
    (`xmp.ts`) and face regions (`regions.ts`);
  - `src/immich/`: the Immich client: one `ImmichClient` per account's session, wrapping `@immich/sdk` (pinned to the
    server's version), plus the sessions and `login`, assets (`assets.ts`: listing, finding by path, and bulk
    changes), albums, faces and people (`albums.ts`, `faces.ts`, `people.ts`), libraries and users (`libraries.ts`), cluster
    groups (`cluster-groups.ts`), and the sync stream (`sync.ts`, read with `fetch`, since the
    SDK's `getSyncStream` reads the whole response as text);
  - `src/sidecars/`: exiftool (`exiftool.ts`), the namespace's exiftool config (`namespace.ts`), and reading, writing
    and creating sidecars (`sidecar.ts`);
  - each module's tests sit beside it (`*.test.ts`).
  - `test/immich/`: a development Immich for the integration tests (`compose.yml`, started and stopped by `dev.ts`),
    and what the tests share (`harness.ts`). Tests that need it are skipped unless `MEDIA_TRIAGE_IMMICH_TESTS=1`;
  - `test/fixtures/`: small media files with made-up metadata, and a sidecar each from Darktable and Immich, made by
    the tools themselves (`make.ts`);
  - `test/darktable.ts`: Darktable, headless (`xvfb-run`), with a throwaway library, configuration, cache and home
    folder, to have it rewrite a copy's sidecar. Tests that need it are skipped without it.
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
- **inotify needs a watch per folder** of the covered folders (section 1). At start, the daemon compares their number
  with `fs.inotify.max_user_watches`, and says how to raise it if it's too low. Other programs, such as Syncthing, use
  watches from the same allowance.
- **The first run is the heaviest:** it reads every sidecar once, and streams every asset once per account. Run it with
  `--dry-run` first, which shows what it would do, with counts.

## History

- 2026-11-03: written, from the plan made for the author's own setup.
- 2026-11-04: the author decided three open questions: F1's unread sidecars are fixed in the fork; F8 mirrors only
  a trash or restore of a copy that isn't offline; the covered folders are the libraries' and the inbox's sources.
- 2026-11-04: sync covers the whole archive, not just the inbox (section 1), and section 13 (scale) added. Section 3
  corrected from Immich 3.3.5's source: `AssetsV2` and `AlbumsV2` instead of the V1 types, the stream carries no
  paths, `AssetFacesV3` covers the cluster group, and resets.
- 2026-11-04: capture times keep their zone in `photoshop:DateCreated`, and a time changed in Darktable reaches
  Immich with it (F6), as the author asked: Darktable has no time zones by design.
- 2026-11-04: sidecar I/O built (milestone 5). Found and written down: Immich's own copies of the description and date
  (F6), Darktable dropping the date's offset (F6), Immich showing Darktable's own tags (F4), and how regions'
  coordinates relate to Immich's faces (F10). Checked that Immich and Darktable keep the namespace and regions (F9,
  F10). F9's namespace and its key settled. The author decided F5 isn't needed.
- 2026-11-04: F9 built: each account's state, from its copies and its stream's albums; a reset keeps what the stream
  reported, stale, until it's sent again. Assets are recorded with their owner's account only.
- 2026-11-04: a copy catching up after a refresh isn't a side (section 5): found in testing, it undid a tag removed
  in Darktable.
- 2026-11-04: F10 built: faces and people kept in the state from the streams, tags and regions from them.
- 2026-11-04: F11 built: orphan sidecars deleted by the full pass, once seen gone for the grace period.
- 2026-11-04: filing built (milestone 8, steps 1–5): readiness, the plan, moving, holding the unit, putting back.
- 2026-11-04: a copy the last sync didn't see isn't a side until it agrees with the sidecar (section 5): found by the
  smoke test, it removed a title.
- 2026-11-05: milestone 8 done: the daemon's smoke test (`test/immich/smoke.ts`) filed a batch end to end, with
  everything put back.
- 2026-11-05: before the first run on real files, three ways it could lose what a sidecar holds, found by reading the
  first run's paths and confirmed by `src/sync/first-contact.test.ts`, and fixed (section 5): a sidecar
  Immich never read lost its tags, title and rating to the copy that didn't read it; a reject was cleared; on the first
  run, a Darktable change Immich hadn't read lost to Immich's older value; and a new account's copy of a trashed photo
  restored it. Each copy is now compared with what it said itself at the last sync, a copy the last sync didn't see
  takes the unit's state, and without a base the sidecar's values come first.
- 2026-11-07: the first dry run on the author's archive found two ways the first run would write wrong values, fixed
  (section 5): embedded tags since reorganized in Darktable came back into it, and photos without any capture time
  got the file's. The image file's own tags and date are now read where Immich may show them. The full pass also
  counts links to files (section 3).
- 2026-11-07: filing moves a photo's Darktable duplicates' sidecars with it (section 7; decided by the author), and the
  watcher no longer takes every sidecar named `…_<digits>.<ext>.xmp` for a duplicate's (section 3).
