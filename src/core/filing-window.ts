// When filing moves files (DESIGN.md, section 7): only in the hour from the configured time of day, in the server's
// local time. A move is heavy for Immich: it scans, reads the new copies in every account, and drops the old ones, so
// it's kept to a quiet time.

/** How long filing may move files after the configured time. */
export const FILING_WINDOW_MS = 60 * 60_000;

/** A time of day written "HH:MM" (24-hour), or null if it isn't one. */
export function parseTimeOfDay(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

export type FilingWindow = { open: true; closesInMs: number } | { open: false; opensInMs: number };

/**
 * Whether `now` is in a filing window, one that opens daily at `at` ("HH:MM", local time) for `lengthMs`, and if not,
 * how long until the next one opens. A time skipped by a clock change opens the window at the first time after it.
 */
export function filingWindow(now: Date, at: string, lengthMs = FILING_WINDOW_MS): FilingWindow {
  const time = parseTimeOfDay(at);
  if (!time) throw new Error(`"${at}" isn't a time of day written HH:MM`);
  const opensOn = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, time.hour, time.minute).getTime();
  const nowMs = now.getTime();
  for (const days of [-1, 0]) {
    const opens = opensOn(days);
    if (nowMs >= opens && nowMs < opens + lengthMs) return { open: true, closesInMs: opens + lengthMs - nowMs };
  }
  const today = opensOn(0);
  return { open: false, opensInMs: (today > nowMs ? today : opensOn(1)) - nowMs };
}
