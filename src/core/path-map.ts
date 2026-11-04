// Translating between Immich's paths (inside its container) and this machine's (DESIGN.md, section 2: `path_map`).

import { posix } from "node:path";

export interface PathMapping {
  /** A folder as Immich sees it, ending in "/". */
  immich: string;
  /** The same folder as this machine sees it, ending in "/". */
  local: string;
}

/** Maps paths both ways. The longest matching folder wins, so a mapping for a subfolder overrides its parent's. */
export class PathMap {
  private readonly byImmich: PathMapping[];
  private readonly byLocal: PathMapping[];

  constructor(mappings: readonly PathMapping[]) {
    for (const mapping of mappings) {
      if (!mapping.immich.endsWith("/") || !mapping.local.endsWith("/")) throw new Error("path_map folders must end with /");
    }
    this.byImmich = [...mappings].sort((a, b) => b.immich.length - a.immich.length);
    this.byLocal = [...mappings].sort((a, b) => b.local.length - a.local.length);
  }

  /** Immich's path as this machine sees it, or undefined if no mapping covers it. */
  toLocal(immichPath: string): string | undefined {
    return translate(immichPath, this.byImmich, "immich", "local");
  }

  /** This machine's path as Immich sees it, or undefined if no mapping covers it. */
  toImmich(localPath: string): string | undefined {
    return translate(localPath, this.byLocal, "local", "immich");
  }
}

function translate(path: string, mappings: readonly PathMapping[], from: "immich" | "local", to: "immich" | "local"): string | undefined {
  if (!posix.isAbsolute(path)) return undefined;
  // Normalized first, so ".." can't climb out of a mapped folder.
  const normal = posix.normalize(path);
  for (const mapping of mappings) {
    if (normal.startsWith(mapping[from])) return mapping[to] + normal.slice(mapping[from].length);
    // The mapped folder itself, written without its slash.
    if (`${normal}/` === mapping[from]) return mapping[to].slice(0, -1);
  }
  return undefined;
}
