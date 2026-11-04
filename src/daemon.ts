import { type Config, requireRunnable } from "./config.ts";
import { formatDuration } from "./duration.ts";
import { EXIT } from "./exit.ts";
import { log } from "./log.ts";
import { Scheduler } from "./scheduler.ts";
import { State } from "./state.ts";
import { upgrade } from "./upgrade.ts";
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

  // Before anything is logged, so a signal right after starting still stops it cleanly.
  const stop = (signal: string) => {
    log.info("stopping", { signal });
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

  // The jobs register here as they're built (RESUME.md has the milestones).

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
  state.close();
  log.info("stopped");
  return exitStatus;
}
