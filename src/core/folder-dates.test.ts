import { describe, expect, test } from "bun:test";
import { allowedSince, parseDay } from "./folder-dates.ts";

const since = parseDay("2019-07-27");

describe("allowedSince 2019-07-27", () => {
  test.each([
    "2019.07.27 - Beach",
    "2019-07-27",
    "20190727_120000 - clip.mp4",
    "2019.07.31",
    "2019.08",
    "2019-08-01 - Fair",
    "201908",
    "2019.08.00",
    "2019.12.25 Xmas",
    "2019-07.28 mixed",
    "2020 Christmas",
    "2023 - Misc",
    "2020",
    "20201225",
    "2020abc",
    "2099",
  ])("allows %p", (name) => {
    expect(allowedSince(name, since)).toBe(true);
  });

  test.each([
    "2019.07.26 - Picnic",
    "2019.07 - July",
    "2019.07",
    "201907",
    "2019.07.00 - month only",
    "2019 Christmas",
    "2019",
    "2019.",
    "2019.7.28",
    "2019.13.01",
    "2019.07.32",
    "2019.00.10",
    "2018.12.31",
    "2012-02-05 - x",
    "2014.12.25 Xmas",
    "2015.06 - Wedding and Misc",
    "1999",
    "2100 plans",
    "Staging",
    "Best-Of Photos",
    "Leo on a Unicycle.MOV",
    "4th of July",
    "",
  ])("excludes %p", (name) => {
    expect(allowedSince(name, since)).toBe(false);
  });
});

test("parseDay", () => {
  expect(parseDay("2019-07-27")).toEqual({ year: 2019, month: 7, day: 27 });
  expect(() => parseDay("2019.07.27")).toThrow("YYYY-MM-DD");
});
