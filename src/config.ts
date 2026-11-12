import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { parseTimeOfDay } from "./core/filing-window.ts";
import type { PathMapping } from "./core/path-map.ts";
import { parseDuration } from "./duration.ts";
import { LEVELS, type Level } from "./log.ts";
import { defaultStateDir, expandHome } from "./paths.ts";

export type { PathMapping };

export const DEFAULT_REPO = "https://github.com/kael-shipman/media-triage";

export type Track = "patch" | "minor" | "major";
export const TRACKS: readonly Track[] = ["patch", "minor", "major"];

export interface Source {
  /** A direct subfolder of the inbox. */
  folder: string;
  /** The creator (`dc:creator`) its files get when they have none. */
  creator: string;
}

export interface Account {
  /** A label, used in logs and as the session file's name. */
  name: string;
  email: string;
  admin: boolean;
}

export interface DatedLimit {
  /** The first day this library includes, `YYYY-MM-DD`. */
  since: string;
  /** Folders (Immich's paths, globs allowed) whose entries' names start with dates. */
  levels: string[];
}

export interface Library {
  account: string;
  name: string;
  /** Immich's paths. */
  folders: string[];
  /** Extra exclusion patterns, besides hidden files and any date limit's. */
  exclude: string[];
  dated?: DatedLimit;
}

export interface UpgradeSettings {
  enabled: boolean;
  repo: string;
  intervalMs: number;
  track: Track;
  prerelease: boolean;
  restart: boolean;
}

export interface Config {
  /** The file it was read from, or null for the defaults alone. */
  file: string | null;
  paths: { inbox?: string; archive?: string; state: string };
  sources: Source[];
  /** `at`: when filing moves files each day, "HH:MM" in the server's local time (DESIGN.md, section 7). */
  filing: { photos: string; videos: string; at: string };
  immich: {
    url?: string;
    pathMap: PathMapping[];
    mirrorsFaceCorrections: boolean;
    /** Whether the server's metadata refresh reads a sidecar that appeared after it indexed the file (F1). */
    readsNewSidecars: boolean;
    accounts: Account[];
    libraries: Library[];
  };
  timing: { settleMs: number; orphanGraceMs: number; fullPassMs: number };
  upgrade: UpgradeSettings;
  log: { level: Level };
}

export class ConfigError extends Error {}

/** Reads and checks a configuration file. With `optional`, a missing file gives the defaults. */
export function loadConfig(file: string, options: { optional?: boolean } = {}): Config {
  if (!existsSync(file)) {
    if (options.optional) return parseConfig({}, null);
    throw new ConfigError(`There's no configuration at ${file}. Write a starter one with \`media-triage init\`.`);
  }
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`${file} isn't valid TOML: ${(error as Error).message}`);
  }
  return parseConfig(raw, file);
}

/** Checks a parsed TOML document and fills in the defaults. */
export function parseConfig(raw: unknown, file: string | null): Config {
  const root = Table.of(raw, "");

  const paths = root.table("paths");
  const inbox = paths.path("inbox");
  const archive = paths.path("archive");
  const state = paths.path("state") ?? defaultStateDir();
  paths.done();

  const sources = root.tables("sources").map((table) => {
    const source = { folder: table.string("folder", { required: true })!, creator: table.string("creator", { required: true })! };
    if (source.folder.includes("/") || source.folder === "." || source.folder === "..") {
      table.fail("folder", "must be the name of a folder directly inside the inbox");
    }
    table.done();
    return source;
  });
  unique(sources.map((source) => source.folder), "sources: folder");

  const filingTable = root.table("filing");
  const filing = {
    photos: filingTable.relativePath("photos") ?? "Pictures",
    videos: filingTable.relativePath("videos") ?? "Videos/Clips",
    at: filingTable.string("at") ?? "04:00",
  };
  const at = parseTimeOfDay(filing.at) ?? filingTable.fail("at", `must be a time of day written HH:MM, like "04:00", not "${filing.at}"`);
  filing.at = `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
  filingTable.done();

  const immichTable = root.table("immich");
  const url = immichTable.url("url");
  const pathMap = immichTable.tables("path_map").map((table) => {
    const mapping = { immich: withSlash(table.path("immich", { required: true })!), local: withSlash(table.path("local", { required: true })!) };
    table.done();
    return mapping;
  });
  unique(pathMap.map((mapping) => mapping.immich), "immich.path_map: immich");
  unique(pathMap.map((mapping) => mapping.local), "immich.path_map: local");
  const mirrorsFaceCorrections = immichTable.bool("mirrors_face_corrections", false);
  const readsNewSidecars = immichTable.bool("reads_new_sidecars", false);

  const accounts = immichTable.tables("accounts").map((table) => {
    const account = {
      name: table.string("name", { required: true })!,
      email: table.string("email", { required: true })!,
      admin: table.bool("admin", false),
    };
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(account.name)) {
      table.fail("name", "must be lowercase letters, digits, - and _ (it names the session file)");
    }
    if (!account.email.includes("@")) table.fail("email", "isn't an email address");
    table.done();
    return account;
  });
  unique(accounts.map((account) => account.name), "immich.accounts: name");
  if (accounts.filter((account) => account.admin).length > 1) {
    throw new ConfigError("immich.accounts: only one account can be the admin");
  }

  const libraries = immichTable.tables("libraries").map((table) => {
    const library: Library = {
      account: table.string("account", { required: true })!,
      name: table.string("name", { required: true })!,
      folders: table.paths("folders", { required: true }),
      exclude: table.stringArray("exclude"),
    };
    if (!accounts.some((account) => account.name === library.account)) {
      table.fail("account", `"${library.account}" isn't one of immich.accounts`);
    }
    if (library.folders.length === 0) table.fail("folders", "needs at least one folder");
    const dated = table.optionalTable("dated");
    if (dated) {
      const since = dated.string("since", { required: true })!;
      if (!isRealDate(since)) dated.fail("since", `"${since}" isn't a date written YYYY-MM-DD`);
      const levels = dated.paths("levels", { required: true });
      if (levels.length === 0) dated.fail("levels", "needs at least one folder");
      dated.done();
      library.dated = { since, levels };
    }
    table.done();
    return library;
  });
  unique(libraries.map((library) => `${library.account}/${library.name}`), "immich.libraries: account and name");
  immichTable.done();

  const timingTable = root.table("timing");
  const timing = {
    settleMs: timingTable.duration("settle", "5m"),
    orphanGraceMs: timingTable.duration("orphan_grace", "1h"),
    fullPassMs: timingTable.duration("full_pass", "24h"),
  };
  timingTable.done();

  const upgradeTable = root.table("upgrade");
  const upgrade: UpgradeSettings = {
    enabled: upgradeTable.bool("enabled", true),
    repo: upgradeTable.url("repo") ?? DEFAULT_REPO,
    intervalMs: upgradeTable.duration("interval", "6h"),
    track: upgradeTable.oneOf("track", TRACKS, "minor"),
    prerelease: upgradeTable.bool("prerelease", false),
    restart: upgradeTable.bool("restart", true),
  };
  if (upgrade.intervalMs < 10 * 60_000) upgradeTable.fail("interval", "must be at least 10m");
  upgradeTable.done();

  const logTable = root.table("log");
  const logSettings = { level: logTable.oneOf("level", LEVELS, "info") };
  logTable.done();

  root.done();

  return {
    file,
    paths: { inbox, archive, state },
    sources,
    filing,
    immich: { url, pathMap, mirrorsFaceCorrections, readsNewSidecars, accounts, libraries },
    timing,
    upgrade,
    log: logSettings,
  };
}

/** Checks what `run` needs beyond what every command needs. */
export function requireRunnable(config: Config): void {
  const missing: string[] = [];
  if (!config.paths.inbox) missing.push("paths.inbox");
  if (!config.paths.archive) missing.push("paths.archive");
  if (!config.immich.url) missing.push("immich.url");
  if (config.immich.accounts.length === 0) missing.push("at least one [[immich.accounts]]");
  if (missing.length > 0) {
    throw new ConfigError(`${config.file ?? "The configuration"} needs ${missing.join(", ")} to run.`);
  }
}

function withSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function isRealDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function unique(values: string[], what: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new ConfigError(`${what}: "${value}" appears twice`);
    seen.add(value);
  }
}

/** One TOML table, read key by key, so that unknown keys (usually typos) can be reported. */
class Table {
  private readonly read = new Set<string>();

  private constructor(
    private readonly values: Record<string, unknown>,
    private readonly where: string,
  ) {}

  static of(value: unknown, where: string): Table {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigError(`${where || "The configuration"} must be a table`);
    }
    return new Table(value as Record<string, unknown>, where);
  }

  private key(key: string): string {
    return this.where ? `${this.where}.${key}` : key;
  }

  fail(key: string, problem: string): never {
    throw new ConfigError(`${this.key(key)} ${problem}`);
  }

  private get(key: string): unknown {
    this.read.add(key);
    return this.values[key];
  }

  string(key: string, options: { required?: boolean } = {}): string | undefined {
    const value = this.get(key);
    if (value === undefined) {
      if (options.required) this.fail(key, "is required");
      return undefined;
    }
    if (typeof value !== "string" || value.trim() === "") this.fail(key, "must be a non-empty string");
    return value;
  }

  path(key: string, options: { required?: boolean } = {}): string | undefined {
    const value = this.string(key, options);
    if (value === undefined) return undefined;
    const path = expandHome(value);
    if (!isAbsolute(path)) this.fail(key, `must be an absolute path (or start with ~), not "${value}"`);
    return path;
  }

  paths(key: string, options: { required?: boolean } = {}): string[] {
    return this.stringArray(key, options).map((value) => {
      const path = expandHome(value);
      if (!isAbsolute(path)) this.fail(key, `must hold absolute paths, not "${value}"`);
      return path;
    });
  }

  relativePath(key: string): string | undefined {
    const value = this.string(key);
    if (value === undefined) return undefined;
    const path = normalize(value).replace(/\/+$/, "");
    if (isAbsolute(path) || path === ".." || path.startsWith("../")) this.fail(key, "must be a folder inside the archive");
    return path;
  }

  url(key: string): string | undefined {
    const value = this.string(key);
    if (value === undefined) return undefined;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      this.fail(key, `isn't a URL: "${value}"`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") this.fail(key, "must be an http or https URL");
    return value.replace(/\/+$/, "");
  }

  bool(key: string, fallback: boolean): boolean {
    const value = this.get(key);
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") this.fail(key, "must be true or false");
    return value;
  }

  duration(key: string, fallback: string): number {
    const value = this.get(key) ?? fallback;
    if (typeof value !== "string") this.fail(key, 'must be a duration in quotes, like "5m"');
    try {
      const ms = parseDuration(value);
      if (ms <= 0) this.fail(key, "must be longer than zero");
      return ms;
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      this.fail(key, (error as Error).message);
    }
  }

  oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const value = this.get(key);
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      this.fail(key, `must be one of ${allowed.map((option) => `"${option}"`).join(", ")}`);
    }
    return value as T;
  }

  stringArray(key: string, options: { required?: boolean } = {}): string[] {
    const value = this.get(key);
    if (value === undefined) {
      if (options.required) this.fail(key, "is required");
      return [];
    }
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "")) {
      this.fail(key, "must be a list of non-empty strings");
    }
    return value as string[];
  }

  /** A sub-table; missing means empty. */
  table(key: string): Table {
    const value = this.get(key);
    return Table.of(value ?? {}, this.key(key));
  }

  optionalTable(key: string): Table | undefined {
    const value = this.get(key);
    return value === undefined ? undefined : Table.of(value, this.key(key));
  }

  /** An array of tables (`[[key]]`, or `key = [{ … }]`); missing means none. */
  tables(key: string): Table[] {
    const value = this.get(key);
    if (value === undefined) return [];
    if (!Array.isArray(value)) this.fail(key, `must be a list of tables ([[${this.key(key)}]])`);
    return value.map((item, index) => Table.of(item, `${this.key(key)}[${index}]`));
  }

  /** Fails on any key that wasn't read: usually a typo. */
  done(): void {
    const unknown = Object.keys(this.values).filter((key) => !this.read.has(key));
    if (unknown.length > 0) {
      throw new ConfigError(`Unknown setting${unknown.length > 1 ? "s" : ""}: ${unknown.map((key) => this.key(key)).join(", ")}`);
    }
  }
}
