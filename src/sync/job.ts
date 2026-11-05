// Sync in the daemon (DESIGN.md, sections 3, 5 and 13). The watcher and the full pass mark units dirty; the sync job
// reads each account's stream, reconciling each batch before acknowledging it, then reconciles the dirty units once
// they've been quiet for a moment, a limited number per run so other jobs aren't held up by a long first run.

import fastGlob from "fast-glob";
import type { Config } from "../config.ts";
import { PathMap } from "../core/path-map.ts";
import { log } from "../log.ts";
import type { RunResult } from "../scheduler.ts";
import { Exiftool } from "../sidecars/exiftool.ts";
import type { State } from "../state.ts";
import { openAccounts } from "../upkeep/accounts.ts";
import { type Covered, coveredFolders, watchAllowance, watchWarning } from "./covered.ts";
import { fullPass } from "./full-pass.ts";
import { type Refreshing, reconcile } from "./reconcile.ts";
import { SyncStore } from "./store.ts";
import { consumeStream, learnAllAssets } from "./stream.ts";
import { DirtyUnits, Watcher } from "./watcher.ts";

/** How long a unit must be quiet before it's reconciled: a sidecar can be written in several steps. */
export const QUIET_MS = 2000;
/** How often each account's sync stream is read, besides after each change. */
export const STREAM_INTERVAL_MS = 60_000;
/** The most dirty units reconciled in one run. */
export const UNITS_PER_RUN = 200;

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

  /** The full pass: marks every unit whose sidecar changed since its record, or that has none. */
  async fullPass(): Promise<void> {
    const result = await fullPass(this.store, this.covered.folders);
    for (const unit of result.changed) this.dirty.add(unit);
    log.info("full pass", { media: result.media, changed: result.changed.length });
  }

  /** The sync job: each account's stream, then the dirty units. */
  async run(): Promise<RunResult | void> {
    const accounts = await openAccounts(this.config);
    for (const { account, problem } of accounts.problems) log.warn("account left out of sync", { account: account.name, problem });
    const ctx = { config: this.config, store: this.store, exiftool: this.exiftool, accounts: new Map(accounts.open.map((open) => [open.account.name, open])), dryRun: this.options.dryRun, refreshing: this.refreshing };

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

  async close(): Promise<void> {
    this.watcher?.close();
    await this.exiftool.close();
  }
}
