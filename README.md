# media-triage

A personal utility I use to manage my household's shared photos and videos. It's public in case it's useful to
someone with a similar setup, but it's built for mine. Expect rough edges, and read the design before relying on it.

> **Status: under construction. Not usable yet.** The foundation works: the command line, the configuration,
> self-upgrading, the installer and releases. So do the Immich client (`media-triage login <account>`) and account
> upkeep: libraries, the cluster group, shared people, and `media-triage check`. The triage itself isn't built yet. What's built and what's next:
> [RESUME.md](RESUME.md).

## What it's for

My setup:
- **Phones sync their camera folders into an inbox,** one subfolder per phone, with Syncthing.
- **The archive is a folder tree,** `Pictures/YYYY.MM.DD - Title/…` and `Videos/Clips/YYYY.MM.DD - Title/…`.
- **[Immich](https://immich.app) indexes the inbox and the archive** as external libraries. Each person has their own
  account, and the files we share are indexed by both accounts, so each of us fully owns a copy.
- **[Darktable](https://www.darktable.org) is the desktop editor.** It works on the same files, in place.
- **XMP sidecars** (`photo.jpg.xmp`) hold the metadata both tools understand.

On its own, that setup has gaps:
- Immich and Darktable write tags in different fields, so a tag added in one doesn't show up in the other.
- Immich never notices when only a sidecar changed.
- A rating or a tag set in one person's account doesn't reach the other person's copy.
- Filing a photo means moving it, and Immich treats a moved file as a new photo. Favorites, albums and face
  corrections are lost.
- Nothing files triaged photos the way my Darktable export preset names them.

**The goal:** triage on the phone (in Immich) or on the desktop (in Darktable), interchangeably. Tag a batch `Promote`,
and it's filed into the archive with nothing lost.

## What it does

One daemon, running where the files and Immich are:
- **Sync:** keeps each sidecar, Darktable's fields and every Immich copy of the file in step, and tells Immich to
  re-read sidecars that changed. It covers the whole archive, not just the inbox: a photo filed years ago can still
  get a new tag or a named face. That covers ratings, tags, titles, descriptions, creators, rejects and trash.
- **Records what Immich keeps only in its database:** each account's favorites, archiving and albums, and the named
  faces, kept in the sidecar. Named faces also become `People|<name>` tags.
- **Filing:** moves what's tagged `Promote` from the inbox into the archive, named like the export preset. It then
  puts back the favorites, albums and face corrections on the new copies.
- **Cleanup:** deletes sidecars whose photo is gone.
- **Account upkeep:** creates each account's Immich libraries. One account can be limited to folders dated on or
  after a given day, and the daemon checks that it sees exactly those. It also keeps people shared and named across
  accounts.
- **Upgrades itself** from this repository's releases, if you let it.

## Where things are

| What | Where |
|---|---|
| The full design: the rules, the edge cases, and why | [docs/DESIGN.md](docs/DESIGN.md) |
| Where things stand, and exactly what to do next | [RESUME.md](RESUME.md) |
| A commented configuration file | [examples/config.toml](examples/config.toml) |
| The installer | [install.sh](install.sh) |

## Installing

Once there's a release (Linux, x64 or arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/kael-shipman/media-triage/main/install.sh | sh
```

This installs one executable to `~/.local/bin/media-triage` and writes a starter configuration to
`~/.config/media-triage/config.toml`. It can also set up a systemd service: run the script with `--help` for the
options. The only other requirement is [exiftool](https://exiftool.org), from Debian's or Ubuntu's
`libimage-exiftool-perl`.

## Upgrades

With `[upgrade] enabled = true`, the daemon checks this repository's releases on a schedule. It installs the newest
version its `track` allows (by default, any release within the same major version) and restarts.

`media-triage upgrade` does the same by hand, and `media-triage upgrade --check` only reports. Every setting is in
[examples/config.toml](examples/config.toml), and the details are in [docs/DESIGN.md](docs/DESIGN.md#11-upgrades).

## Development

[Bun](https://bun.sh) 1.4 builds and runs it. Without Bun installed, `npx bun@1.4.4` stands in for `bun`.

```sh
bun install
bun test             # unit tests
bun run typecheck    # TypeScript
bun run build        # executables for linux-x64 and linux-arm64, in dist/
bun src/main.ts help # run it from source
```

The Immich client's integration tests need a development Immich (3.3.5, in Docker, on `127.0.0.1:2284`). They're
skipped unless `MEDIA_TRIAGE_IMMICH_TESTS=1`:

```sh
bun run immich up                        # start it, with two made-up users
MEDIA_TRIAGE_IMMICH_TESTS=1 bun test     # every test, the integration tests included
bun run immich down                      # stop it, and delete its data
```

## License

MIT. See [LICENSE](LICENSE).
