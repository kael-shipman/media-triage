// Keeping each account's libraries as configured (DESIGN.md, section 8). Never deletes a library.

import type { Config, Library as ConfiguredLibrary } from "../config.ts";
import { type ExistingLibrary, type WantedLibrary, planLibraries, wantedLibrary } from "../core/libraries.ts";
import { createLibrary, listLibraries, listUsers, scanLibrary, updateLibrary } from "../immich/libraries.ts";
import { log } from "../log.ts";
import type { OpenAccount } from "./accounts.ts";

export interface LibraryOutcome {
  /** Configured libraries, by `account/name`, with their Immich IDs once they exist. */
  libraries: { configured: ConfiguredLibrary; id?: string }[];
  /** What was done (or, with `dryRun`, would be), by `account/name`. */
  created: string[];
  updated: string[];
  unchanged: string[];
  /** The IDs of the libraries scanned because they changed. */
  scanned: string[];
  /** Libraries in Immich that aren't configured: reported, never deleted. */
  unknown: { name: string; owner: string }[];
  /** Configured libraries left alone this pass, and why. */
  skipped: { library: string; reason: string }[];
}

const key = (library: { account: string; name: string }) => `${library.account}/${library.name}`;

/**
 * Creates the missing libraries, corrects the ones that differ, and scans what changed. Every call needs the admin's
 * session. A library is created only for an account that's in the cluster group (`inGroup`), so its faces cluster into
 * the existing people; correcting an existing one needs only the admin, so a fix to its exclusions is never held up.
 */
export async function upkeepLibraries(
  config: Config,
  admin: OpenAccount | undefined,
  inGroup: ReadonlySet<string>,
  options: { dryRun: boolean },
): Promise<LibraryOutcome> {
  const outcome: LibraryOutcome = { libraries: [], created: [], updated: [], unchanged: [], scanned: [], unknown: [], skipped: [] };
  const configured = config.immich.libraries;
  outcome.libraries = configured.map((library) => ({ configured: library }));
  if (configured.length === 0) return outcome;
  if (!admin) {
    const adminName = config.immich.accounts.find((account) => account.admin)?.name;
    const reason = adminName ? `the admin account, ${adminName}, isn't logged in` : "no account is the admin (admin = true), which libraries need";
    outcome.skipped = configured.map((library) => ({ library: key(library), reason }));
    return outcome;
  }

  // Owners by email, from Immich itself, so libraries are matched even for accounts that aren't logged in.
  const users = await listUsers(admin.client);
  const idByEmail = new Map(users.map((user) => [user.email.toLowerCase(), user.id]));
  const emailById = new Map(users.map((user) => [user.id, user.email]));
  const wanted: WantedLibrary[] = [];
  for (const library of configured) {
    const account = config.immich.accounts.find((candidate) => candidate.name === library.account)!;
    const ownerId = idByEmail.get(account.email.toLowerCase());
    if (!ownerId) {
      outcome.skipped.push({ library: key(library), reason: `Immich has no account ${account.email}` });
      continue;
    }
    wanted.push(wantedLibrary(library, ownerId));
  }

  const existing: ExistingLibrary[] = (await listLibraries(admin.client)).map(({ id, ownerId, name, importPaths, exclusionPatterns }) => ({
    id,
    ownerId,
    name,
    importPaths,
    exclusionPatterns,
  }));
  const plan = planLibraries(wanted, existing);
  for (const { library, problem } of plan.problems) outcome.skipped.push({ library: key(library), reason: problem });
  outcome.unknown = plan.unknown.map((library) => ({ name: library.name, owner: emailById.get(library.ownerId) ?? library.ownerId }));

  const setId = (library: WantedLibrary, id: string) => {
    const entry = outcome.libraries.find((candidate) => key(candidate.configured) === key(library));
    if (entry) entry.id = id;
  };
  const verb = options.dryRun ? "would " : "";
  for (const action of plan.actions) {
    const label = key(action.wanted);
    if (action.kind === "unchanged") {
      setId(action.wanted, action.existing.id);
      outcome.unchanged.push(label);
      continue;
    }
    if (action.kind === "create") {
      if (!inGroup.has(action.wanted.account)) {
        outcome.skipped.push({ library: label, reason: `${action.wanted.account} isn't in the cluster group yet, so its libraries wait` });
        continue;
      }
      log.info(`${verb}create library`, { library: label, folders: action.wanted.importPaths, exclusions: action.wanted.exclusionPatterns.length });
      outcome.created.push(label);
      if (options.dryRun) continue;
      const created = await createLibrary(admin.client, action.wanted.ownerId, action.wanted);
      setId(action.wanted, created.id);
      await scanLibrary(admin.client, created.id);
      outcome.scanned.push(created.id);
      continue;
    }
    setId(action.wanted, action.existing.id);
    log.info(`${verb}update library`, {
      library: label,
      folders: action.changes.importPaths,
      exclusions: action.changes.exclusionPatterns && `${action.existing.exclusionPatterns.length} → ${action.changes.exclusionPatterns.length}`,
    });
    outcome.updated.push(label);
    if (options.dryRun) continue;
    await updateLibrary(admin.client, action.existing.id, action.changes);
    await scanLibrary(admin.client, action.existing.id);
    outcome.scanned.push(action.existing.id);
  }
  for (const library of outcome.unknown) log.warn("a library in Immich isn't configured; leaving it alone", library);
  for (const skipped of outcome.skipped) log.warn("library left alone this pass", skipped);
  return outcome;
}
