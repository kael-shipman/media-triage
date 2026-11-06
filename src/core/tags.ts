// Tags, as Immich and Darktable each write them in a sidecar (DESIGN.md, F4).
//
// Immich writes `digiKam:TagsList` as "Parent/Child". Darktable writes `lr:hierarchicalSubject` as "Parent|Child",
// plus `dc:subject` with every part of every tag. Each tool reads only its own field, so keeping them equal shows
// every tag once in each tool. The canonical form here is Immich's.

/** Darktable's own tags ("darktable|format|jpg", "darktable|changed"), which aren't synced. */
export function isDarktableInternal(darktableTag: string): boolean {
  return darktableTag === "darktable" || darktableTag.startsWith("darktable|");
}

/**
 * Darktable's own tags as Immich shows them ("darktable/format/jpg"). Immich reads `lr:hierarchicalSubject` whole when
 * a sidecar has no `TagsList`, so they reach Immich too, and are left out of the sync there as well.
 */
export function isDarktableInternalInImmich(immichTag: string): boolean {
  return immichTag === "darktable" || immichTag.startsWith("darktable/");
}

/**
 * Darktable's "Parent|Child" as Immich shows it: the parts joined with "/", with any "/" inside a part turned into
 * "|". That's Immich's own conversion (metadata.service.ts, getTagList), so "Music|AC/DC" is "Music/AC|DC".
 */
export function toImmich(darktableTag: string): string {
  return darktableTag
    .split("|")
    .map((part) => part.replaceAll("/", "|"))
    .join("/");
}

/** Immich's "Parent/Child" as Darktable writes it. Undoes `toImmich`. */
export function toDarktable(immichTag: string): string {
  return immichTag
    .split("/")
    .map((part) => part.replaceAll("|", "/"))
    .join("|");
}

/** `dc:subject` for Darktable's hierarchical tags: every part of every tag, once each, in first-seen order. */
export function dcSubject(darktableTags: Iterable<string>): string[] {
  const parts = new Set<string>();
  for (const tag of darktableTags) {
    for (const part of tag.split("|")) if (part !== "") parts.add(part);
  }
  return [...parts];
}

/**
 * Three-way merge of tag sets. Each side's changes since `base` (the last-synced set) apply: a tag added on any side
 * is added, and a tag removed on any side is removed. A side with `last` (what it held at the last sync) is compared
 * with that instead: it removes only a tag it held then, and adds only one it didn't, so a side that hasn't caught up
 * with the last sync changes nothing. Without a base (the state was lost), it's the union, which never drops a tag.
 * The result is sorted, so equal sets compare equal.
 */
export function mergeTags(base: Iterable<string> | undefined, sides: { tags: Iterable<string>; last?: Iterable<string> }[]): string[] {
  const result = new Set<string>();
  if (base === undefined) {
    for (const side of sides) for (const tag of side.tags) result.add(tag);
    return [...result].sort();
  }
  const baseSet = new Set(base);
  const removed = new Set<string>();
  const added = new Set<string>();
  for (const side of sides) {
    const now = new Set(side.tags);
    const before = side.last === undefined ? baseSet : new Set(side.last);
    for (const tag of before) if (baseSet.has(tag) && !now.has(tag)) removed.add(tag);
    for (const tag of now) if (!before.has(tag) && !baseSet.has(tag)) added.add(tag);
  }
  for (const tag of baseSet) if (!removed.has(tag)) result.add(tag);
  for (const tag of added) result.add(tag);
  return [...result].sort();
}

/** Whether two tag lists hold the same tags, in any order. */
export function sameTags(a: Iterable<string>, b: Iterable<string>): boolean {
  const [x, y] = [new Set(a), new Set(b)];
  return x.size === y.size && [...x].every((tag) => y.has(tag));
}
