import { type Config, requireRunnable } from "./config.ts";
import { formatDuration } from "./duration.ts";
import { EXIT } from "./exit.ts";
import { log } from "./log.ts";
import { Scheduler } from "./scheduler.ts";
import { State } from "./state.ts";
import { FILING_INTERVAL_MS, STREAM_INTERVAL_MS, Sync } from "./sync/job.ts";
import { upgrade } from "./upgrade.ts";
import { checkJob, upkeepJob } from "./upkeep/upkeep.ts";
import { IS_COMPILED, VERSION } from "./version.ts";

export interface DaemonOptions {
  dryRun: boolean;
}

/** Runs until SIGTERM or SIGINT, and returns the process's exit status. */
export async function runDaemon(config: Config, options: DaemonOptions): Promise<number> {
  requireRunnable(config);
  const state = State.open(config.paths.state);
  const scheduler = new Scheduler();
  let exitStatus: number = EXIT.ok;

  // Before anything is logged, so a signal right after starting still stops it cleanly. Jobs that wait get the
  // abort signal, so stopping doesn't wait for them.
  const stopping = new AbortController();
  const stop = (signal: string) => {
    log.info("stopping", { signal });
    stopping.abort();
    scheduler.stop();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  log.info("media-triage starting", {
    version: VERSION,
    config: config.file,
    state: config.paths.state,
    dryRun: options.dryRun || undefined,
  });

  // Sync (DESIGN.md, sections 3 and 5): the full pass at start and daily; the sync job each minute and after each
  // change the watcher sees. Without exiftool, the daemon stops here, saying how to install it.
  const sync = await Sync.start(config, state, { dryRun: options.dryRun, signal: stopping.signal }, () => scheduler.trigger("sync"));

  // Account upkeep (DESIGN.md, section 8): at start, then on every full pass. The check follows each upkeep, once
  // Immich has finished any scan it started.
  scheduler.add("upkeep", { intervalMs: config.timing.fullPassMs, firstInMs: 0 }, async () => {
    const result = await upkeepJob(config, { dryRun: options.dryRun, signal: stopping.signal });
    if (!result) scheduler.trigger("check");
    return result;
  });
  scheduler.add("check", { intervalMs: config.timing.fullPassMs, firstInMs: config.timing.fullPassMs }, () => checkJob(config, { signal: stopping.signal }));
  scheduler.add("full-pass", { intervalMs: config.timing.fullPassMs, firstInMs: 0 }, async () => {
    await sync.fullPass();
    scheduler.trigger("sync");
  });
  scheduler.add("sync", { intervalMs: STREAM_INTERVAL_MS, firstInMs: 0 }, () => sync.run());
  // Filing (DESIGN.md, section 7): every minute, for putting back after a move. It moves promoted units only in the hour
  // from filing.at, then sooner when a unit is only waiting out the settle time.
  log.info("promoted units are filed daily", { at: config.filing.at, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  scheduler.add("filing", { intervalMs: FILING_INTERVAL_MS, firstInMs: 0 }, () => sync.file());

  if (config.upgrade.enabled && !IS_COMPILED) {
    log.info("automatic upgrades are on, but this runs from source, so it won't upgrade itself");
  } else if (config.upgrade.enabled) {
    // The first check is a minute after starting, unless the last one was more recent than the interval.
    const lastCheck = Date.parse(state.get("upgrade.lastCheck") ?? "") || 0;
    const firstInMs = Math.max(60_000, lastCheck + config.upgrade.intervalMs - Date.now());
    log.info("automatic upgrades are on", {
      track: config.upgrade.track,
      every: formatDuration(config.upgrade.intervalMs),
      nextIn: formatDuration(firstInMs),
    });
    scheduler.add("upgrade", { intervalMs: config.upgrade.intervalMs, firstInMs }, async () => {
      try {
        const result = await upgrade({ ...config.upgrade, executable: process.execPath, current: VERSION });
        if (result.status !== "upgraded") {
          log.debug("no newer release", { track: config.upgrade.track });
          return;
        }
        log.info("upgraded", { from: result.from, to: result.to });
        if (config.upgrade.restart) {
          log.info("exiting so the service manager starts the new version");
          exitStatus = EXIT.upgraded;
          scheduler.stop();
        } else {
          log.info("the new version runs from the next start");
        }
      } finally {
        state.set("upgrade.lastCheck", new Date().toISOString());
      }
    });
  }

  await scheduler.loop();
  await sync.close();
  state.close();
  log.info("stopped");
  return exitStatus;
}
