// What each configured library should be in Immich, and what to change to get there (DESIGN.md, section 8).

import type { Library as ConfiguredLibrary } from "../config.ts";
import { MAX_EXCLUSION_PATTERNS, datedExclusions } from "./exclusions.ts";

/**
 * Immich's own exclusions for a new library (`library.service.ts`, `create`). They're kept, so that a library made in
 * Immich's interface and then configured here isn't changed for no reason.
 */
export const IMMICH_DEFAULT_EXCLUSIONS: readonly string[] = [
  "**/@eaDir/**",
  "**/._*",
  "**/#recycle/**",
  "**/#snapshot/**",
  "**/.stversions/**",
  "**/.stfolder/**",
];

/** Hidden files and folders, which every library excludes. */
export const HIDDEN_EXCLUSIONS: readonly string[] = ["**/.*", "**/.*/**"];

/** A library as it should be. */
export interface WantedLibrary {
  /** The configured account's name. */
  account: string;
  ownerId: string;
  name: string;
  importPaths: string[];
  exclusionPatterns: string[];
}

/** A library as Immich has it. */
export interface ExistingLibrary {
  id: string;
  ownerId: string;
  name: string;
  importPaths: string[];
  exclusionPatterns: string[];
}

export type LibraryAction =
  | { kind: "create"; wanted: WantedLibrary }
  | { kind: "update"; wanted: WantedLibrary; existing: ExistingLibrary; changes: { importPaths?: string[]; exclusionPatterns?: string[] } }
  | { kind: "unchanged"; wanted: WantedLibrary; existing: ExistingLibrary };

export interface LibraryPlan {
  actions: LibraryAction[];
  /** Libraries in Immich that aren't configured. They're reported, never deleted. */
  unknown: ExistingLibrary[];
  /** Configured libraries that can't be set up as they are, each with why. Nothing is done for them. */
  problems: { library: WantedLibrary; problem: string }[];
}

/** A configured library's exclusion patterns: Immich's defaults, hidden files, the configured ones, and its date limit's. */
export function exclusionsFor(library: ConfiguredLibrary): string[] {
  return [...new Set([...IMMICH_DEFAULT_EXCLUSIONS, ...HIDDEN_EXCLUSIONS, ...library.exclude, ...(library.dated ? datedExclusions(library.dated) : [])])];
}

/** A configured library as it should be in Immich, for the owner with this user ID. */
export function wantedLibrary(library: ConfiguredLibrary, ownerId: string): WantedLibrary {
  return { account: library.account, ownerId, name: library.name, importPaths: [...library.folders], exclusionPatterns: exclusionsFor(library) };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set([...a, ...b]).size === new Set(a).size;

/**
 * Compares the wanted libraries with Immich's, matching them by owner and name. Lists are compared as sets: Immich
 * doesn't care about their order, so neither does the plan.
 */
export function planLibraries(wanted: readonly WantedLibrary[], existing: readonly ExistingLibrary[]): LibraryPlan {
  const plan: LibraryPlan = { actions: [], unknown: [], problems: [] };
  const matched = new Set<string>();
  for (const library of wanted) {
    if (library.exclusionPatterns.length > MAX_EXCLUSION_PATTERNS) {
      plan.problems.push({ library, problem: `${library.exclusionPatterns.length} exclusion patterns, but Immich allows at most ${MAX_EXCLUSION_PATTERNS}` });
      continue;
    }
    const candidates = existing.filter((found) => found.ownerId === library.ownerId && found.name === library.name);
    for (const candidate of candidates) matched.add(candidate.id);
    if (candidates.length > 1) {
      plan.problems.push({ library, problem: `the account has ${candidates.length} libraries named "${library.name}": rename all but one in Immich` });
      continue;
    }
    const [found] = candidates;
    if (!found) {
      plan.actions.push({ kind: "create", wanted: library });
      continue;
    }
    const changes: { importPaths?: string[]; exclusionPatterns?: string[] } = {};
    if (!sameSet(found.importPaths, library.importPaths)) changes.importPaths = library.importPaths;
    if (!sameSet(found.exclusionPatterns, library.exclusionPatterns)) changes.exclusionPatterns = library.exclusionPatterns;
    plan.actions.push(Object.keys(changes).length > 0 ? { kind: "update", wanted: library, existing: found, changes } : { kind: "unchanged", wanted: library, existing: found });
  }
  plan.unknown = existing.filter((found) => !matched.has(found.id));
  return plan;
}
