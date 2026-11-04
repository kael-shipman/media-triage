import { type Config, requireRunnable } from "./config.ts";
import { log } from "./log.ts";
import { Scheduler } from "./scheduler.ts";
import { State } from "./state.ts";
import { VERSION } from "./version.ts";

export interface DaemonOptions {
  dryRun: boolean;
}

/** Runs until SIGTERM or SIGINT, and returns the process's exit status. */
export async function runDaemon(config: Config, options: DaemonOptions): Promise<number> {
  requireRunnable(config);
  const state = State.open(config.paths.state);
  const scheduler = new Scheduler();
  const exitStatus = 0;

  log.info("media-triage starting", {
    version: VERSION,
    config: config.file,
    state: config.paths.state,
    dryRun: options.dryRun || undefined,
  });

  // The jobs register here as they're built (RESUME.md has the milestones).

  const stop = (signal: string) => {
    log.info("stopping", { signal });
    scheduler.stop();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  await scheduler.loop();
  state.close();
  log.info("stopped");
  return exitStatus;
}
