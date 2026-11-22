import { expect, test } from "bun:test";
import { CREATOR, creatorProblem, titleProblem, titlesIn, titleTag, withTitle } from "./titles.ts";

test("titles are the tags under Title/", () => {
  expect(titleTag("Beach Day")).toBe("Title/Beach Day");
  expect(titlesIn(["People/Robin", "Title/Beach Day", "Titles/x", "Title/Other"])).toEqual(["Beach Day", "Other"]);
});

test("withTitle replaces every title tag with one, or removes them", () => {
  expect(withTitle(["A", "Title/Old", "Title/Older"], "New")).toEqual(["A", "Title/New"]);
  expect(withTitle(["A", "Title/Old"], undefined)).toEqual(["A"]);
});

test.each([
  ["Beach Day", undefined],
  ["Robin's 3rd Birthday (Grandma's)", undefined],
  ["", "it's empty"],
  [" Beach", "it starts or ends with a space"],
  ["Beach/Day", 'holds a "/" or "|"'],
  ["Beach|Day", 'holds a "/" or "|"'],
  ["..", "isn't a usable folder name"],
  ["a\tb", "control character"],
  ["é".repeat(101), "longer than 200 bytes"],
])("title %p: %p", (title, problem) => {
  if (problem === undefined) expect(titleProblem(title)).toBeUndefined();
  else expect(titleProblem(title)).toContain(problem);
});

test("creators are the tags under Creator/, like titles", () => {
  expect(CREATOR.tag("Alex Example")).toBe("Creator/Alex Example");
  expect(CREATOR.valuesIn(["Title/Beach Day", "Creator/Alex Example", "Creators/x"])).toEqual(["Alex Example"]);
  expect(CREATOR.with(["A", "Title/Beach Day", "Creator/Old"], "New")).toEqual(["A", "Title/Beach Day", "Creator/New"]);
  expect(CREATOR.with(["A", "Creator/Old"], undefined)).toEqual(["A"]);
});

test.each([
  ["Alex Example", undefined],
  ["Ángela O'Brien-Example", undefined],
  ["..", undefined],
  ["", "it's empty"],
  ["Alex ", "it starts or ends with a space"],
  ["Alex/Sam", 'holds a "/" or "|"'],
  ["a\nb", "control character"],
])("creator %p: %p", (creator, problem) => {
  if (problem === undefined) expect(creatorProblem(creator)).toBeUndefined();
  else expect(creatorProblem(creator)).toContain(problem);
});
