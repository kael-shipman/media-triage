import { describe, expect, test } from "bun:test";
import { allowedSince, parseDay } from "./folder-dates.ts";

const since = parseDay("2020-06-15");

describe("allowedSince 2020-06-15", () => {
  test.each([
    "2020.06.15 - Beach",
    "2020-06-15",
    "20200615_120000 - clip.mp4",
    "2020.06.30",
    "2020.07",
    "2020-07-01 - Fair",
    "202007",
    "2020.07.00",
    "2020.12.25 Xmas",
    "2020-06.16 mixed",
    "2021 Christmas",
    "2023 - Misc",
    "2021",
    "20211225",
    "2021abc",
    "2099",
  ])("allows %p", (name) => {
    expect(allowedSince(name, since)).toBe(true);
  });

  test.each([
    "2020.06.14 - Picnic",
    "2020.06 - June",
    "2020.06",
    "202006",
    "2020.06.00 - month only",
    "2020 Christmas",
    "2020",
    "2020.",
    "2020.6.16",
    "2020.13.01",
    "2020.06.32",
    "2020.00.10",
    "2019.12.31",
    "2011-03-04 - x",
    "2013.12.25 Xmas",
    "2016.05 - Trip and Misc",
    "1999",
    "2100 plans",
    "Staging",
    "Highlights",
    "Kid on a Unicycle.MOV",
    "Summer Fair",
    "",
  ])("excludes %p", (name) => {
    expect(allowedSince(name, since)).toBe(false);
  });
});

test("parseDay", () => {
  expect(parseDay("2020-06-15")).toEqual({ year: 2020, month: 6, day: 15 });
  expect(() => parseDay("2020.06.15")).toThrow("YYYY-MM-DD");
});
