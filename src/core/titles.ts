// The batch title: the Immich tag "Title/<title>", which is Darktable's title (`dc:title`) (DESIGN.md, F3). Filing
// uses it as the folder name: "YYYY.MM.DD - <title>".

export const TITLE_TAG = "Title";

/** The Immich tag for a title. */
export function titleTag(title: string): string {
  return `${TITLE_TAG}/${title}`;
}

/** The titles in a list of Immich tags: the part after "Title/", for every tag under it. */
export function titlesIn(immichTags: Iterable<string>): string[] {
  const titles: string[] = [];
  for (const tag of immichTags) if (tag.startsWith(`${TITLE_TAG}/`)) titles.push(tag.slice(TITLE_TAG.length + 1));
  return titles;
}

/** The tags, with any title tags replaced by one for `title` (or none, if it's undefined). */
export function withTitle(immichTags: Iterable<string>, title: string | undefined): string[] {
  const others = [...immichTags].filter((tag) => !tag.startsWith(`${TITLE_TAG}/`));
  return title === undefined ? others : [...others, titleTag(title)];
}

/** Why a title can't be used, or undefined if it can. */
export function titleProblem(title: string): string | undefined {
  if (title.trim() === "") return "it's empty";
  if (title !== title.trim()) return "it starts or ends with a space";
  if (title.includes("/") || title.includes("|")) return 'it holds a "/" or "|", which would nest the tag in Immich or Darktable';
  if (title === "." || title === "..") return "it isn't a usable folder name";
  if (/[\u0000-\u001f]/.test(title)) return "it holds a control character";
  // The folder is "YYYY.MM.DD - <title>", and folder names are limited to 255 bytes.
  if (new TextEncoder().encode(title).length > 200) return "it's longer than 200 bytes";
  return undefined;
}
