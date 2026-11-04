import { expect, test } from "bun:test";
import { titleProblem, titlesIn, titleTag, withTitle } from "./titles.ts";

test("titles are the tags under Title/", () => {
  expect(titleTag("Beach Day")).toBe("Title/Beach Day");
  expect(titlesIn(["People/Ari", "Title/Beach Day", "Titles/x", "Title/Other"])).toEqual(["Beach Day", "Other"]);
});

test("withTitle replaces every title tag with one, or removes them", () => {
  expect(withTitle(["A", "Title/Old", "Title/Older"], "New")).toEqual(["A", "Title/New"]);
  expect(withTitle(["A", "Title/Old"], undefined)).toEqual(["A"]);
});

test.each([
  ["Beach Day", undefined],
  ["Ari's 3rd Birthday (Grandma's)", undefined],
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
