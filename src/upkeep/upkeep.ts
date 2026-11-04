// Account upkeep, in order (DESIGN.md, section 8): accounts, the cluster group, libraries, people. Run by the daemon
// at start and on every full pass. Every step is idempotent, and a dry run only reports.
//
// The check is a job of its own (`checkJob`), run after upkeep once Immich has finished the scans upkeep started.
// Upkeep doesn't wait for them: the daemon runs one job at a time, and a wait would hold up sync.

import type { Config } from "../config.ts";
import { formatDuration } from "../duration.ts";
import { ImmichError } from "../immich/client.ts";
import { libraryQueueIdle, listLibraries } from "../immich/libraries.ts";
import { log } from "../log.ts";
import type { RunResult } from "../scheduler.ts";
import { openAccounts } from "./accounts.ts";
import { type CheckReport, checkLibraries, formatReport } from "./check.ts";
import { joinClusterGroup } from "./cluster.ts";
import { type LibraryOutcome, upkeepLibraries } from "./libraries.ts";
import { type PeopleOutcome, upkeepPeople } from "./people.ts";

/** How soon to try again when Immich can't be reached, such as while it starts after a reboot. */
export const UNREACHABLE_RETRY_MS = 5 * 60_000;
/** How soon the check looks again while Immich's library queue is busy. */
export const CHECK_RETRY_MS = 60_000;

export interface UpkeepReport {
  /** Accounts that couldn't take part, and why. */
  problems: { account: string; problem: string }[];
  joined: string[];
  libraries: LibraryOutcome;
  people: PeopleOutcome;
}

export interface UpkeepOptions {
  dryRun: boolean;
  /** Aborted when the daemon stops: upkeep returns at its next step. */
  signal?: AbortSignal;
}

export async function runUpkeep(config: Config, options: UpkeepOptions): Promise<UpkeepReport> {
  const accounts = await openAccounts(config);
  const problems = accounts.problems.map(({ account, problem }) => ({ account: account.name, problem }));

  const cluster = await joinClusterGroup(config.immich.accounts[0]?.name, accounts.open, options);
  problems.push(...cluster.problems.map(({ account, problem }) => ({ account: account.name, problem })));
  const inGroup = accounts.open.filter((open) => cluster.inGroup.has(open.account.name));

  const admin = accounts.open.find((open) => open.account.admin);
  const libraries = await upkeepLibraries(config, admin, cluster.inGroup, options);

  const people = options.signal?.aborted ? { shared: [], named: [], conflicts: [] } : await upkeepPeople(inGroup, options);
  const report: UpkeepReport = { problems, joined: cluster.joined, libraries, people };
  logReport(report, options.dryRun);
  return report;
}

function logReport(report: UpkeepReport, dryRun: boolean): void {
  for (const { account, problem } of report.problems) log.warn("account left out of upkeep", { account, problem });
  const { created, updated, scanned, unknown } = report.libraries;
  log.info(dryRun ? "account upkeep done (dry run: nothing changed)" : "account upkeep done", {
    joined: report.joined.length || undefined,
    created: created.length || undefined,
    updated: updated.length || undefined,
    scanned: scanned.length || undefined,
    unconfigured: unknown.length || undefined,
    named: report.people.named.length || undefined,
    problems: report.problems.length || undefined,
  });
}

/** The daemon's job: upkeep, retried sooner if Immich can't be reached. */
export async function upkeepJob(config: Config, options: UpkeepOptions): Promise<RunResult | void> {
  return retryIfUnreachable("account upkeep", () => runUpkeep(config, options));
}

/**
 * The check (section 8), once Immich's library queue has been idle at two looks in a row, so it sees the result of
 * any scan upkeep started. "busy" if the queue isn't idle yet; undefined without the admin's session, which it needs
 * to find the libraries.
 */
export async function checkIfIdle(config: Config, options: { pollMs?: number; signal?: AbortSignal } = {}): Promise<CheckReport | "busy" | undefined> {
  const accounts = await openAccounts(config);
  const admin = accounts.open.find((open) => open.account.admin);
  if (!admin) return undefined;
  if (!(await libraryQueueIdle(admin.client))) return "busy";
  await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
  if (options.signal?.aborted || !(await libraryQueueIdle(admin.client))) return "busy";
  return checkLibraries(config, accounts.open, await listLibraries(admin.client));
}

/** The daemon's job: the check, after each upkeep, looking again each minute while Immich's scans run. */
export async function checkJob(config: Config, options: { signal?: AbortSignal } = {}): Promise<RunResult | void> {
  return retryIfUnreachable("the check", async () => {
    const report = await checkIfIdle(config, options);
    if (report === "busy") {
      log.debug("Immich's library queue is busy; the check waits", { for: formatDuration(CHECK_RETRY_MS) });
      return { nextInMs: CHECK_RETRY_MS };
    }
    if (report === undefined) {
      log.warn("the check needs the admin account's session, to find the libraries");
      return;
    }
    const lines = formatReport(report);
    if (report.ok) {
      log.info("check passed", { libraries: report.libraries.length });
      for (const line of lines.slice(1)) log.info(line);
    } else {
      log.error("CHECK FAILED: a library limited by date doesn't hold exactly what its date allows. Nothing was changed to fix it.");
      for (const line of lines) log.error(line);
    }
  });
}

async function retryIfUnreachable(what: string, run: () => Promise<unknown>): Promise<RunResult | void> {
  try {
    const result = await run();
    if (result && typeof result === "object" && "nextInMs" in result) return result as RunResult;
  } catch (error) {
    if (error instanceof ImmichError && error.status === 0) {
      log.warn(`Immich can't be reached; ${what} tries again soon`, { in: formatDuration(UNREACHABLE_RETRY_MS), error: error.message });
      return { nextInMs: UNREACHABLE_RETRY_MS };
    }
    throw error;
  }
}
