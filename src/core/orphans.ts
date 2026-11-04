// Which media file a sidecar belongs to (DESIGN.md, F11). Deciding when an orphan may be deleted needs the state,
// and lives with the sync.

const SIDECAR = /\.xmp$/i;

export function isSidecar(name: string): boolean {
  return SIDECAR.test(name);
}

/** A Syncthing conflict copy, like "photo.jpg.sync-conflict-20261103-101010-ABCDEFG.xmp": reported, never deleted. */
export function isConflictCopy(name: string): boolean {
  return /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}/.test(name);
}

/**
 * The media file a sidecar belongs to, among the names in its folder, or undefined if there's none:
 * - "<file>.<ext>.xmp" belongs to "<file>.<ext>";
 * - a Darktable duplicate's "<stem>_01.<ext>.xmp" belongs to "<stem>.<ext>" (the exact name wins, since filing also
 *   uses "_01");
 * - "<stem>.xmp" belongs to any "<stem>.<ext>" that isn't itself a sidecar.
 */
export function sidecarOwner(sidecar: string, siblings: Iterable<string>): string | undefined {
  const names = new Set(siblings);
  const media = sidecar.replace(SIDECAR, "");
  if (names.has(media) && !isSidecar(media)) return media;

  const duplicate = /^(.*)_\d{2,}(\.[^.]+)$/.exec(media);
  if (duplicate && names.has(duplicate[1]! + duplicate[2]!)) return duplicate[1]! + duplicate[2]!;

  for (const name of [...names].sort()) {
    if (!isSidecar(name) && name.startsWith(`${media}.`) && !name.slice(media.length + 1).includes(".")) return name;
  }
  return undefined;
}
