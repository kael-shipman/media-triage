// Account upkeep, in order (DESIGN.md, section 8): accounts, the cluster group, libraries, the check, people.
// Run by the daemon at start and on every full pass. Every step is idempotent, and a dry run only reports.

import type { Config } from "../config.ts";
import { formatDuration } from "../duration.ts";
import { ImmichError } from "../immich/client.ts";
import { listLibraries, waitForLibraryQueue } from "../immich/libraries.ts";
import { log } from "../log.ts";
import type { RunResult } from "../scheduler.ts";
import { openAccounts } from "./accounts.ts";
import { type CheckReport, checkLibraries, formatReport } from "./check.ts";
import { joinClusterGroup } from "./cluster.ts";
import { type LibraryOutcome, upkeepLibraries } from "./libraries.ts";
import { type PeopleOutcome, upkeepPeople } from "./people.ts";

/** How long to wait for Immich's scans before the check, which then waits for the next pass. */
export const SCAN_TIMEOUT_MS = 30 * 60_000;
/** How soon to try again when Immich can't be reached, such as while it starts after a reboot. */
export const UNREACHABLE_RETRY_MS = 5 * 60_000;

export interface UpkeepReport {
  /** Accounts that couldn't take part, and why. */
  problems: { account: string; problem: string }[];
  joined: string[];
  libraries: LibraryOutcome;
  /** Missing if the scans didn't finish in time, or no account is the admin. */
  check?: CheckReport;
  people: PeopleOutcome;
}

export interface UpkeepOptions {
  dryRun: boolean;
  scanTimeoutMs?: number;
  /** Aborted when the daemon stops: upkeep returns at its next step instead of waiting for Immich's scans. */
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

  let check: CheckReport | undefined;
  if (admin) {
    const timeoutMs = options.scanTimeoutMs ?? SCAN_TIMEOUT_MS;
    const scansDone = libraries.scanned.length === 0 || (await waitForLibraryQueue(admin.client, timeoutMs, 1000, options.signal));
    if (options.signal?.aborted) {
      log.info("stopping: account upkeep ends before the check");
    } else if (scansDone) {
      check = await checkLibraries(config, accounts.open, await listLibraries(admin.client));
    } else {
      log.warn("Immich's scans are still running; the check waits for the next pass", { waited: formatDuration(options.scanTimeoutMs ?? SCAN_TIMEOUT_MS) });
    }
  }

  const people = options.signal?.aborted ? { shared: [], named: [], conflicts: [] } : await upkeepPeople(inGroup, options);
  const report: UpkeepReport = { problems, joined: cluster.joined, libraries, check, people };
  logReport(report, options.dryRun);
  return report;
}

function logReport(report: UpkeepReport, dryRun: boolean): void {
  for (const { account, problem } of report.problems) log.warn("account left out of upkeep", { account, problem });
  if (report.check) {
    const lines = formatReport(report.check);
    if (report.check.ok) {
      log.info("check passed", { libraries: report.check.libraries.length });
      for (const line of lines.slice(1)) log.info(line);
    } else {
      log.error("CHECK FAILED: a library limited by date doesn't hold exactly what its date allows. Nothing was changed to fix it.");
      for (const line of lines) log.error(line);
    }
  }
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
  try {
    await runUpkeep(config, options);
  } catch (error) {
    if (error instanceof ImmichError && error.status === 0) {
      log.warn("Immich can't be reached; account upkeep tries again soon", { in: formatDuration(UNREACHABLE_RETRY_MS), error: error.message });
      return { nextInMs: UNREACHABLE_RETRY_MS };
    }
    throw error;
  }
}
