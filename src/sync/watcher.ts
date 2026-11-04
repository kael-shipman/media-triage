// The watcher (DESIGN.md, sections 3 and 13): inotify over the covered folders, through Bun's recursive `fs.watch`,
// which watches every folder (new ones too) with one inotify instance. Each change is reported as the unit it belongs
// to; the daemon's own writes come back too, and the reconcile finds nothing to do for them.

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { unitOf } from "./covered.ts";

export class Watcher {
  private readonly watchers: FSWatcher[] = [];

  /** Watches the folders, calling `onUnit` with the media file of each change. */
  constructor(folders: readonly string[], onUnit: (media: string) => void) {
    for (const folder of folders) {
      try {
        const watcher = watch(folder, { recursive: true }, (_event, name) => {
          if (typeof name !== "string") return;
          const unit = unitOf(join(folder, name));
          if (unit) onUnit(unit);
        });
        watcher.on("error", (error) => log.error("watching failed; changes there wait for the full pass", { folder, error }));
        this.watchers.push(watcher);
      } catch (error) {
        log.error("can't watch a covered folder; changes there wait for the full pass", { folder, error: error as Error });
      }
    }
  }

  get watching(): number {
    return this.watchers.length;
  }

  close(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
  }
}

/**
 * Units that changed, with when each last did, so a burst of events (a sidecar written in several steps) is acted on
 * once it has been quiet for a moment.
 */
export class DirtyUnits {
  private readonly changed = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  add(media: string): void {
    this.changed.set(media, this.now());
  }

  get size(): number {
    return this.changed.size;
  }

  /**
   * Takes the units quiet for at least `quietMs`, at most `limit` of them, and says how soon to take more: now, if
   * quiet ones are left over, or when the next one will be quiet (undefined if none are left).
   */
  take(quietMs: number, limit = Number.POSITIVE_INFINITY): { units: string[]; nextInMs?: number } {
    const now = this.now();
    const units: string[] = [];
    let soonest: number | undefined;
    for (const [media, at] of this.changed) {
      const left = at + quietMs - now;
      if (left > 0) soonest = Math.min(soonest ?? left, left);
      else if (units.length < limit) {
        units.push(media);
        this.changed.delete(media);
      } else soonest = 0;
    }
    return { units: units.sort(), nextInMs: soonest };
  }
}
