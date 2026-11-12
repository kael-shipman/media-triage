import { afterAll, beforeAll, expect, test } from "bun:test";
import { filingWindow, parseTimeOfDay } from "./filing-window.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Local times, in a zone with daylight saving time.
let zone: string | undefined;
beforeAll(() => {
  zone = process.env.TZ;
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

test("a time of day is HH:MM, 24-hour", () => {
  expect(parseTimeOfDay("04:00")).toEqual({ hour: 4, minute: 0 });
  expect(parseTimeOfDay("4:30")).toEqual({ hour: 4, minute: 30 });
  expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
  for (const text of ["24:00", "04:60", "4", "04:00:00", "4am", " 04:00", ""]) expect(parseTimeOfDay(text)).toBeNull();
});

test("open for the hour from the time, closed until the next one otherwise", () => {
  expect(filingWindow(new Date(2026, 10, 11, 4, 0), "04:00")).toEqual({ open: true, closesInMs: HOUR });
  expect(filingWindow(new Date(2026, 10, 11, 4, 59), "04:00")).toEqual({ open: true, closesInMs: MINUTE });
  expect(filingWindow(new Date(2026, 10, 11, 5, 0), "04:00")).toEqual({ open: false, opensInMs: 23 * HOUR });
  expect(filingWindow(new Date(2026, 10, 11, 3, 30), "04:00")).toEqual({ open: false, opensInMs: 30 * MINUTE });
  expect(filingWindow(new Date(2026, 10, 11, 20, 0), "04:00")).toEqual({ open: false, opensInMs: 8 * HOUR });
});

test("a window that opens before midnight stays open after it", () => {
  expect(filingWindow(new Date(2026, 10, 12, 0, 10), "23:30")).toEqual({ open: true, closesInMs: 20 * MINUTE });
  expect(filingWindow(new Date(2026, 10, 12, 0, 30), "23:30")).toEqual({ open: false, opensInMs: 23 * HOUR });
});

test("in local time, across clock changes", () => {
  // 2026-03-08: 02:00 doesn't happen in Chicago, so the window opens at 03:00 (CDT).
  expect(filingWindow(new Date(2026, 2, 8, 3, 15), "02:00")).toEqual({ open: true, closesInMs: 45 * MINUTE });
  // 2026-11-01: 01:00–02:00 happens twice; from 00:00, 02:00 is three hours away.
  expect(filingWindow(new Date(2026, 10, 1, 0, 0), "02:00")).toEqual({ open: false, opensInMs: 3 * HOUR });
});
