// Values Darktable keeps in a field of their own, which Immich shows as a tag under a parent (DESIGN.md, F3):
// - the batch title: the tag "Title/<title>", which is Darktable's title (`dc:title`). Filing uses it as the folder
//   name: "YYYY.MM.DD - <title>";
// - the creator: the tag "Creator/<creator>", which is Darktable's creator (`dc:creator`). Filing uses it in the file
//   name: "YYYY.MM.DD-HH.MM.SS - <creator>".
// Immich shows neither field, so the tag is how it's seen and changed there.

/** A field shown as tags under `parent`. */
export interface FieldTag {
  parent: string;
  /** The Immich tag for a value. */
  tag(value: string): string;
  /** Whether a tag is one of this field's. */
  is(tag: string): boolean;
  /** The values in a list of Immich tags: the part after "<parent>/", for every tag under it. */
  valuesIn(immichTags: Iterable<string>): string[];
  /** The tags, with this field's tags replaced by one for `value` (or none, if it's undefined). */
  with(immichTags: Iterable<string>, value: string | undefined): string[];
}

function fieldTag(parent: string): FieldTag {
  const prefix = `${parent}/`;
  return {
    parent,
    tag: (value) => `${prefix}${value}`,
    is: (tag) => tag.startsWith(prefix),
    valuesIn: (immichTags) => [...immichTags].flatMap((tag) => (tag.startsWith(prefix) ? [tag.slice(prefix.length)] : [])),
    with: (immichTags, value) => {
      const others = [...immichTags].filter((tag) => !tag.startsWith(prefix));
      return value === undefined ? others : [...others, `${prefix}${value}`];
    },
  };
}

export const TITLE = fieldTag("Title");
export const CREATOR = fieldTag("Creator");

export const TITLE_TAG = TITLE.parent;
export const titleTag = TITLE.tag;
export const titlesIn = TITLE.valuesIn;
export const withTitle = TITLE.with;

/** Why a value can't be a tag's, or undefined if it can. */
function tagValueProblem(value: string): string | undefined {
  if (value.trim() === "") return "it's empty";
  if (value !== value.trim()) return "it starts or ends with a space";
  if (value.includes("/") || value.includes("|")) return 'it holds a "/" or "|", which would nest the tag in Immich or Darktable';
  if (/[\u0000-\u001f]/.test(value)) return "it holds a control character";
  // The folder is "YYYY.MM.DD - <title>", the file "YYYY.MM.DD-HH.MM.SS - <creator>_01.<ext>", and names are limited
  // to 255 bytes.
  if (new TextEncoder().encode(value).length > 200) return "it's longer than 200 bytes";
  return undefined;
}

/** Why a title can't be used, or undefined if it can. */
export function titleProblem(title: string): string | undefined {
  if (title === "." || title === "..") return "it isn't a usable folder name";
  return tagValueProblem(title);
}

/** Why a creator can't be used, or undefined if it can. */
export function creatorProblem(creator: string): string | undefined {
  return tagValueProblem(creator);
}
