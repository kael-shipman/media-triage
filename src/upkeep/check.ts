// The check (DESIGN.md, section 8): a library limited by date holds exactly the files its rule allows.
//
// It never changes anything. Both directions are checked against the rule itself (`classifyPath`), not against the
// exclusion patterns made from it, so a mistake in the patterns shows up here:
// - every asset in the library, offline ones included (an offline asset still shows in the account's trash), must be
//   allowed;
// - every file the rule allows, found the way Immich's crawler finds files, must be in the library.

import fastGlob from "fast-glob";
import picomatch from "picomatch";
import type { Config, Library as ConfiguredLibrary } from "../config.ts";
import { type PathVerdict, classifyPath, parseDay } from "../core/folder-dates.ts";
import { HIDDEN_EXCLUSIONS, IMMICH_DEFAULT_EXCLUSIONS } from "../core/libraries.ts";
import { IMMICH_EXTENSIONS } from "../core/media.ts";
import { PathMap } from "../core/path-map.ts";
import { type Asset, libraryPages } from "../immich/assets.ts";
import type { Library } from "../immich/libraries.ts";
import type { OpenAccount } from "./accounts.ts";

/** How many paths a report lists for each kind of finding; the counts are always complete. */
export const SAMPLES = 20;

export interface LibraryCheck {
  /** `account/name`. */
  library: string;
  /** Why it couldn't be checked, if it couldn't. That's a failure too: nothing is confirmed. */
  skipped?: string;
  /** Assets the rule doesn't allow (Immich's paths). Each one is a privacy failure. */
  forbidden: { path: string; why: string; offline: boolean }[];
  /** Files the rule allows that aren't in the library (Immich's paths). */
  missing: string[];
  /** Files left out of `missing` because they changed after the library's last scan. */
  tooNew: number;
  /** Names at the dated levels that the rule leaves out for having no date, a vague one, or being loose files. */
  undated: { name: string; why: string; files: number }[];
  /** The account's inbox assets dated before the cutover, which it can see until they're filed. */
  earlyInbox: { path: string; date: string }[];
}

export interface CheckReport {
  libraries: LibraryCheck[];
  /** True when every date-limited library was checked and nothing failed. */
  ok: boolean;
}

const key = (library: { account: string; name: string }) => `${library.account}/${library.name}`;

/** The files Immich crawls in a folder (`storage.repository.ts`, `asGlob`), relative to it. */
const CRAWL_GLOB = `**/*{${IMMICH_EXTENSIONS.join(",")}}`;

/**
 * How Immich matches exclusion patterns outside its crawler, "to match the behavior of fast-glob's micromatch"
 * (`storage.repository.ts`, `watch`).
 */
const MATCH_OPTIONS = { dot: true, nocase: true, posix: true, strictSlashes: false };

/** Every asset in a library, a page at a time. */
async function allAssets(owner: OpenAccount, libraryId: string): Promise<Asset[]> {
  const assets: Asset[] = [];
  for await (const page of libraryPages(owner.client, libraryId)) assets.push(...page);
  return assets;
}

/** Checks one date-limited library, given its owner's session and Immich's record of it. */
export async function checkLibrary(
  config: Config,
  configured: ConfiguredLibrary,
  library: Library,
  owner: OpenAccount,
  inboxLibraries: readonly Library[],
): Promise<LibraryCheck> {
  const result: LibraryCheck = { library: key(configured), forbidden: [], missing: [], tooNew: 0, undated: [], earlyInbox: [] };
  const dated = configured.dated!;
  const since = parseDay(dated.since);
  const map = new PathMap(config.immich.pathMap);
  const classify = (path: string): PathVerdict => classifyPath(path, dated.levels, since);

  // Every asset must be allowed.
  const assets = await allAssets(owner, library.id);
  const online = new Set<string>();
  for (const asset of assets) {
    if (!asset.isOffline) online.add(asset.originalPath);
    const verdict = classify(asset.originalPath);
    if (verdict.kind === "rejected") result.forbidden.push({ path: asset.originalPath, why: `${verdict.why}: ${verdict.name}`, offline: asset.isOffline });
  }

  // Every allowed file must be an asset. Found as Immich's crawler finds them, inside each folder, and filtered by the
  // library's exclusions other than the date limit's, matched against Immich's paths. Matching local paths instead
  // would go wrong when the local folders are inside a hidden one (`~/.media/…`): `**/.*/**` would exclude everything.
  const folders = configured.folders.map((folder) => ({ immich: folder, local: map.toLocal(folder) }));
  const unmapped = folders.find((folder) => folder.local === undefined);
  if (unmapped) {
    result.skipped = `${unmapped.immich} isn't covered by immich.path_map, so its files can't be found here`;
    return result;
  }
  const excluded = picomatch([...IMMICH_DEFAULT_EXCLUSIONS, ...HIDDEN_EXCLUSIONS, ...configured.exclude], MATCH_OPTIONS);
  if (!library.refreshedAt) {
    result.skipped = "it hasn't been scanned yet";
    return result;
  }
  // Set when the scan's crawl ends: a file that arrived during the crawl, after its folder was crawled, can still be
  // reported missing once.
  const lastScan = Date.parse(library.refreshedAt);
  const undated = new Map<string, { why: string; files: number }>();
  const seen = new Set<string>();
  let crawled = 0;
  for (const folder of folders) {
    const entries = fastGlob.stream(CRAWL_GLOB, {
      cwd: folder.local!,
      absolute: true,
      caseSensitiveMatch: false,
      onlyFiles: true,
      dot: false,
      stats: true,
      objectMode: true,
    });
    for await (const entry of entries as AsyncIterable<fastGlob.Entry>) {
      crawled++;
      const path = map.toImmich(entry.path);
      // Overlapping folders find a file twice.
      if (path === undefined || excluded(path) || seen.has(path)) continue;
      seen.add(path);
      considerFile(path, entry.stats?.ctimeMs ?? 0);
    }
  }
  function considerFile(path: string, ctimeMs: number): void {
    const verdict = classify(path);
    if (verdict.kind === "rejected") {
      if (verdict.why !== "before") {
        const name = undated.get(verdict.name) ?? { why: verdict.why, files: 0 };
        name.files++;
        undated.set(verdict.name, name);
      }
      return;
    }
    if (online.has(path)) return;
    // A file moved or copied in since the last scan keeps its mtime, but not its ctime.
    if (ctimeMs > lastScan) {
      result.tooNew++;
      return;
    }
    result.missing.push(path);
  }
  if (crawled === 0 && online.size > 0) {
    result.skipped = `no media files were found in its folders here, but Immich has ${online.size}: check immich.path_map, and that the folders are on this machine`;
    return result;
  }
  result.undated = [...undated].map(([name, found]) => ({ name, ...found })).sort((a, b) => a.name.localeCompare(b.name));
  result.missing.sort();

  // The owner's inbox assets from before the cutover.
  for (const inbox of inboxLibraries) {
    for (const asset of await allAssets(owner, inbox.id)) {
      const date = (asset.localDateTime ?? asset.fileCreatedAt).slice(0, 10);
      if (date < dated.since) result.earlyInbox.push({ path: asset.originalPath, date });
    }
  }
  result.earlyInbox.sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path));
  return result;
}

/**
 * Checks every configured library limited by date. `libraries` is Immich's list (the admin's). An owner that isn't
 * logged in, or a library that doesn't exist yet, can't be checked, and the report says so.
 */
export async function checkLibraries(config: Config, accounts: readonly OpenAccount[], libraries: readonly Library[]): Promise<CheckReport> {
  const report: CheckReport = { libraries: [], ok: true };
  const map = new PathMap(config.immich.pathMap);
  const inboxImmich = config.paths.inbox ? map.toImmich(config.paths.inbox) : undefined;
  const isInbox = (library: Library) =>
    inboxImmich !== undefined && library.importPaths.length > 0 && library.importPaths.every((path) => path === inboxImmich || path.startsWith(`${inboxImmich}/`));

  for (const configured of config.immich.libraries.filter((library) => library.dated)) {
    const empty: LibraryCheck = { library: key(configured), forbidden: [], missing: [], tooNew: 0, undated: [], earlyInbox: [] };
    const owner = accounts.find((open) => open.account.name === configured.account);
    if (!owner) {
      report.libraries.push({ ...empty, skipped: `${configured.account} isn't logged in, and only its own session can list its assets` });
      continue;
    }
    const library = libraries.find((found) => found.ownerId === owner.userId && found.name === configured.name);
    if (!library) {
      report.libraries.push({ ...empty, skipped: "it isn't in Immich yet" });
      continue;
    }
    const inboxes = libraries.filter((found) => found.ownerId === owner.userId && found.id !== library.id && isInbox(found));
    report.libraries.push(await checkLibrary(config, configured, library, owner, inboxes));
  }
  report.ok = report.libraries.every((check) => !check.skipped && check.forbidden.length === 0 && check.missing.length === 0);
  return report;
}

/** The report as lines of text, failures first, with at most `SAMPLES` paths for each finding. */
export function formatReport(report: CheckReport): string[] {
  const lines: string[] = [];
  const list = (items: string[]) => [...items.slice(0, SAMPLES).map((item) => `    ${item}`), ...(items.length > SAMPLES ? [`    … and ${items.length - SAMPLES} more`] : [])];
  if (report.libraries.length === 0) return ["No library is limited by date: nothing to check."];
  for (const check of report.libraries) {
    if (check.skipped) {
      lines.push(`FAILED  ${check.library}: not checked: ${check.skipped}`);
      continue;
    }
    const failed = check.forbidden.length > 0 || check.missing.length > 0;
    lines.push(`${failed ? "FAILED" : "OK    "}  ${check.library}`);
    if (check.forbidden.length > 0) {
      lines.push(`  ${check.forbidden.length} asset(s) the date limit doesn't allow, which this account can see:`);
      lines.push(...list(check.forbidden.map((item) => `${item.path} (${item.why}${item.offline ? "; offline, in the trash" : ""})`)));
    }
    if (check.missing.length > 0) {
      lines.push(`  ${check.missing.length} file(s) the date limit allows that aren't in the library:`);
      lines.push(...list(check.missing));
    }
    if (check.tooNew > 0) lines.push(`  ${check.tooNew} file(s) changed after the last scan, left for the next check.`);
    if (check.undated.length > 0) {
      lines.push(`  ${check.undated.length} name(s) left out for having no date, or not a precise enough one:`);
      lines.push(...list(check.undated.map((item) => `${item.name} (${item.why}, ${item.files} file(s))`)));
    }
    if (check.earlyInbox.length > 0) {
      lines.push(`  ${check.earlyInbox.length} inbox asset(s) dated before the cutover, which this account sees until they're filed:`);
      lines.push(...list(check.earlyInbox.map((item) => `${item.date}  ${item.path}`)));
    }
  }
  return lines;
}
