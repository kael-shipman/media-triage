// Sync in the daemon (DESIGN.md, sections 3, 5 and 13). The watcher and the full pass mark units dirty; the sync job
// reads each account's stream, reconciling each batch before acknowledging it, then reconciles the dirty units once
// they've been quiet for a moment, a limited number per run so other jobs aren't held up by a long first run. The
// filing job (section 7) shares its state, exiftool and accounts.

import fastGlob from "fast-glob";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { PROMOTE_TAG } from "../core/naming.ts";
import { PathMap } from "../core/path-map.ts";
import { fileBatch, finishPlanned } from "../filing/file.ts";
import { restorePending } from "../filing/restore.ts";
import { FilingStore } from "../filing/store.ts";
import { log } from "../log.ts";
import type { RunResult } from "../scheduler.ts";
import { Exiftool } from "../sidecars/exiftool.ts";
import type { State } from "../state.ts";
import { type OpenAccount, openAccounts } from "../upkeep/accounts.ts";
import { type Covered, coveredFolders, watchAllowance, watchWarning } from "./covered.ts";
import { fullPass } from "./full-pass.ts";
import { handleOrphans } from "./orphans.ts";
import { type ReconcileContext, type Refreshing, reconcile } from "./reconcile.ts";
import { SyncStore } from "./store.ts";
import { consumeStream, learnAllAssets } from "./stream.ts";
import { DirtyUnits, Watcher } from "./watcher.ts";

/** How long a unit must be quiet before it's reconciled: a sidecar can be written in several steps. */
export const QUIET_MS = 2000;
/** How often each account's sync stream is read, besides after each change. */
export const STREAM_INTERVAL_MS = 60_000;
/** The most dirty units reconciled in one run. */
export const UNITS_PER_RUN = 200;
/** How often the filing job looks at the inbox units tagged Promote. */
export const FILING_INTERVAL_MS = 60_000;

export interface SyncOptions {
  dryRun: boolean;
  signal?: AbortSignal;
}

export class Sync {
  private readonly dirty = new DirtyUnits();
  private readonly store: SyncStore;
  private readonly map: PathMap;
  private watcher: Watcher | undefined;
  /** A dry run reads the streams once, since it acknowledges nothing and would read them whole each time. */
  private streamed = false;
  /** Whether the filing job has run since the daemon started: plans with problems are retried once then. */
  private filedBefore = false;
  /** The filing problems last logged, by unit, so each is logged when it first appears. */
  private filingProblems = new Map<string, string>();
  /** What units being put back were last logged as waiting for. */
  private restoreWaits = new Map<string, string>();
  /** Copies catching up after a refresh (src/sync/reconcile.ts). */
  private readonly refreshing = new Map<string, Refreshing>();

  private constructor(
    private readonly config: Config,
    state: State,
    private readonly exiftool: Exiftool,
    private readonly covered: Covered,
    private readonly options: SyncOptions,
  ) {
    this.store = new SyncStore(state.db);
    this.map = new PathMap(config.immich.pathMap);
  }

  /**
   * Starts exiftool and the watcher. A missing exiftool throws `ExiftoolMissing`, which stops the daemon: it doesn't
   * run without sidecars. `onDirty` is called on every change the watcher sees (the daemon triggers the sync job).
   */
  static async start(config: Config, state: State, options: SyncOptions, onDirty: () => void): Promise<Sync> {
    const exiftool = await Exiftool.start();
    const covered = coveredFolders(config);
    for (const folder of covered.unmapped) log.warn("a library's folder isn't in the path map, so it isn't synced", { folder });
    const sync = new Sync(config, state, exiftool, covered, options);
    let folders = covered.folders.length;
    for (const folder of covered.folders) folders += (await fastGlob("**", { cwd: folder, onlyDirectories: true, dot: false, suppressErrors: true })).length;
    const warning = watchWarning(folders, watchAllowance());
    if (warning) log.warn(warning);
    sync.watcher = new Watcher(covered.folders, (unit) => {
      sync.dirty.add(unit);
      onDirty();
    });
    log.info("sync started", { covered: covered.folders.length, folders, exiftool: `${exiftool.version} (${exiftool.path})` });
    return sync;
  }

  /**
   * The full pass: marks every unit whose sidecar changed since its record, or that has none, and deletes orphan
   * sidecars whose media file has been gone for the grace period (F11).
   */
  async fullPass(): Promise<void> {
    const result = await fullPass(this.store, this.covered.folders);
    for (const unit of result.changed) this.dirty.add(unit);
    const { dryRun } = this.options;
    const orphans = handleOrphans(this.store, result.orphans, { graceMs: this.config.timing.orphanGraceMs, now: Date.now(), dryRun });
    for (const sidecar of orphans.deleted) log.info(dryRun ? "would delete an orphan sidecar" : "deleted an orphan sidecar: its media file is gone", { sidecar });
    log.info("full pass", {
      media: result.media,
      changed: result.changed.length,
      orphans: result.orphans.length || undefined,
      deleted: orphans.deleted.length || undefined,
    });
    if (orphans.unknown.length > 0) {
      log.warn("sidecars whose media file was never seen here: left as they are", { count: orphans.unknown.length, first: orphans.unknown.slice(0, 5).join(", ") });
    }
    if (result.conflicts.length > 0) {
      log.warn("Syncthing conflict copies of sidecars: merge or delete them by hand", { count: result.conflicts.length, first: result.conflicts.slice(0, 5).join(", ") });
    }
  }

  /** What the reconcile and filing need, with every account that can be opened now. */
  private async context(): Promise<{ ctx: ReconcileContext; accounts: OpenAccount[] }> {
    const accounts = await openAccounts(this.config);
    for (const { account, problem } of accounts.problems) log.warn("account left out of sync", { account: account.name, problem });
    const ctx: ReconcileContext = {
      config: this.config,
      store: this.store,
      exiftool: this.exiftool,
      accounts: new Map(accounts.open.map((open) => [open.account.name, open])),
      dryRun: this.options.dryRun,
      refreshing: this.refreshing,
    };
    return { ctx, accounts: accounts.open };
  }

  /** The sync job: each account's stream, then the dirty units. */
  async run(): Promise<RunResult | void> {
    const { ctx, accounts: open } = await this.context();
    const accounts = { open };

    if (!(this.options.dryRun && this.streamed)) {
      for (const account of accounts.open) {
        if (this.options.signal?.aborted) return;
        if (this.store.countAssets(account.account.name) === 0) {
          const learned = await learnAllAssets(account, this.store, this.map);
          log.info("learned the account's assets", { account: account.account.name, assets: learned });
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const outcome = await consumeStream(account, this.store, this.map, {
            act: async (units) => void (await reconcile(ctx, units)),
            dryRun: this.options.dryRun,
            signal: this.options.signal,
          });
          if (!outcome.reset) break;
          await learnAllAssets(account, this.store, this.map);
        }
      }
      this.streamed = true;
    }

    if (this.options.signal?.aborted) return;
    const { units, nextInMs } = this.dirty.take(QUIET_MS, UNITS_PER_RUN);
    if (units.length > 0) await reconcile(ctx, units);
    return nextInMs === undefined ? undefined : { nextInMs };
  }

  /**
   * The filing job (DESIGN.md, section 7): finishes plans a run left unfinished, then reconciles the inbox units tagged
   * Promote, which says which are ready, and files those; then puts back what Immich keeps per asset on units filed
   * earlier, once their new copies are there. Looks again sooner when a unit is only waiting out the settle time.
   * Problems, and what put-back units wait for, are logged when they first appear, not every run.
   */
  async file(): Promise<RunResult | void> {
    const { ctx } = await this.context();
    const finished = await finishPlanned(ctx, { retryProblems: !this.filedBefore });
    this.filedBefore = true;
    const restored = await restorePending(ctx);
    for (const { unit, problems } of restored.done) for (const problem of problems) log.warn("not all put back after filing", { unit, problem });
    const waiting = new Map(restored.waiting.map(({ unit, why }) => [unit, why]));
    for (const [unit, why] of waiting) if (this.restoreWaits.get(unit) !== why) log.info("putting back after filing: waiting", { unit, for: why });
    this.restoreWaits = waiting;
    if (!this.config.paths.inbox || this.options.signal?.aborted) return;
    const sources = this.config.sources.map((source) => join(this.config.paths.inbox!, source.folder));
    const filings = new FilingStore(this.store.db);
    const candidates = this.store.unitsTagged(sources, PROMOTE_TAG).filter((unit) => filings.get(unit)?.status !== "planned");
    const report = candidates.length > 0 ? await reconcile(ctx, candidates) : undefined;
    const filed = report ? await fileBatch(ctx, report.ready) : { filed: [], problems: [] };

    const problems = new Map([...finished.problems, ...filed.problems].map(({ unit, problem }) => [unit, problem]));
    for (const { unit, why } of report?.notReady ?? []) if (why === "it has no title") problems.set(unit, "it's tagged Promote, but has no title");
    for (const [unit, problem] of problems) if (this.filingProblems.get(unit) !== problem) log.warn("not filed", { unit, problem });
    this.filingProblems = problems;
    if (filed.filed.length > 0) log.info(this.options.dryRun ? "would file (dry run)" : "filed a batch", { units: filed.filed.length });

    const soonest = Math.min(...(report?.notReady ?? []).flatMap((unit) => (unit.inMs !== undefined ? [unit.inMs] : [])));
    return Number.isFinite(soonest) && soonest < FILING_INTERVAL_MS ? { nextInMs: Math.max(1000, soonest) } : undefined;
  }

  async close(): Promise<void> {
    this.watcher?.close();
    await this.exiftool.close();
  }
}
