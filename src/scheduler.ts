import { formatDuration } from "./duration.ts";
import { log } from "./log.ts";

/** What a run can ask for: to run again sooner than its interval, such as after a failure worth retrying. */
export interface RunResult {
  nextInMs?: number;
}

interface Job {
  name: string;
  intervalMs: number;
  nextAt: number;
  /** Set by `trigger()`, so a trigger during a run isn't lost. */
  triggered: boolean;
  run: () => Promise<void | RunResult>;
}

/**
 * Runs the daemon's jobs one at a time, each on its own interval or when triggered. Running them one at a time is
 * deliberate: no job ever runs in the middle of another, so for example an upgrade never interrupts filing.
 */
export class Scheduler {
  private readonly jobs: Job[] = [];
  private stopped = false;
  private wake: (() => void) | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  add(name: string, timing: { intervalMs: number; firstInMs?: number }, run: () => Promise<void | RunResult>): void {
    this.jobs.push({ name, intervalMs: timing.intervalMs, nextAt: this.now() + (timing.firstInMs ?? 0), triggered: false, run });
    this.wake?.();
  }

  /** Makes a job due now. */
  trigger(name: string): void {
    const job = this.jobs.find((candidate) => candidate.name === name);
    if (!job) throw new Error(`No job named ${name}`);
    job.nextAt = this.now();
    job.triggered = true;
    this.wake?.();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  /** Runs jobs until `stop()`. A job that throws is logged, and runs again at its next time. */
  async loop(): Promise<void> {
    while (!this.stopped) {
      const job = this.jobs.reduce<Job | undefined>((soonest, candidate) => (!soonest || candidate.nextAt < soonest.nextAt ? candidate : soonest), undefined);
      const waitMs = job ? Math.max(0, job.nextAt - this.now()) : Number.POSITIVE_INFINITY;
      if (waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = Number.isFinite(waitMs) ? setTimeout(resolve, Math.min(waitMs, 2 ** 31 - 1)) : undefined;
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
        continue;
      }
      if (!job) continue;
      const started = this.now();
      job.triggered = false;
      let result: void | RunResult = undefined;
      try {
        result = await job.run();
      } catch (error) {
        log.error(`${job.name} failed`, { error });
      }
      log.debug(`${job.name} done`, { took: formatDuration(this.now() - started) });
      // Triggered again while it ran: leave it due. Otherwise, its next turn is an interval from now, or sooner if
      // the run asked for it.
      if (!job.triggered) job.nextAt = this.now() + Math.min(job.intervalMs, result?.nextInMs ?? job.intervalMs);
    }
  }
}
