import { describe, expect, test } from "bun:test";
import { type NamedPerson, type PeopleFromTagsInput, personNameOf, personTagName, planPeopleFromTags } from "./people-from-tags.ts";

test("a People/… tag names the person in its last part, with | read as /", () => {
  expect(personNameOf("People/Robin Example")).toBe("Robin Example");
  expect(personNameOf("People/Family/Robin Example")).toBe("Robin Example");
  expect(personNameOf("People/AC|DC")).toBe("AC/DC");
  expect(personNameOf("People/Family")).toBe("Family");
  expect(personNameOf("People/")).toBeUndefined();
  expect(personNameOf("Places/Lake")).toBeUndefined();
  expect(personNameOf("Title/People")).toBeUndefined();
  expect(personTagName(" AC/DC ")).toBe("AC|DC");
});

describe("planPeopleFromTags", () => {
  const people: Record<string, Record<string, NamedPerson[]>> = {
    alex: { "Robin Example": [{ id: "p-robin", hidden: false }], "Kit Example": [{ id: "p-kit", hidden: false }], Hidden: [{ id: "p-hidden", hidden: true }], Twice: [{ id: "p-1", hidden: false }, { id: "p-2", hidden: false }] },
    sam: { "Robin Example": [{ id: "p-robin", hidden: false }] },
  };
  const input = (changes: Partial<PeopleFromTagsInput> = {}): PeopleFromTagsInput => ({
    tags: ["People/Robin Example", "Places/Lake"],
    made: [],
    copies: [
      { account: "alex", asset: "a1" },
      { account: "sam", asset: "s1" },
    ],
    peopleNamed: (account, name) => people[account]?.[name] ?? [],
    present: new Set(),
    added: new Set(),
    mirrors: true,
    ...changes,
  });

  test("a tagged person with no face gets one, on the first copy when the server mirrors them", () => {
    expect(planPeopleFromTags(input())).toEqual({ add: [{ account: "alex", asset: "a1", person: "p-robin", name: "Robin Example" }], ambiguous: [] });
  });

  test("without mirroring, on each copy whose account names the person", () => {
    expect(planPeopleFromTags(input({ mirrors: false })).add.map((face) => face.asset)).toEqual(["a1", "s1"]);
  });

  test("a nested tag names its last part; a group names no one", () => {
    const plan = planPeopleFromTags(input({ tags: ["People/Family/Kit Example", "People/Family"] }));
    expect(plan.add.map((face) => face.person)).toEqual(["p-kit"]);
  });

  test("nothing for a person already on the file, added before, hidden, unknown, or from a tag the daemon made", () => {
    expect(planPeopleFromTags(input({ present: new Set(["p-robin"]) })).add).toEqual([]);
    expect(planPeopleFromTags(input({ added: new Set(["p-robin"]) })).add).toEqual([]);
    expect(planPeopleFromTags(input({ tags: ["People/Hidden", "People/Nobody"] })).add).toEqual([]);
    expect(planPeopleFromTags(input({ made: ["People/Robin Example"] })).add).toEqual([]);
  });

  test("two people with one name in an account are ambiguous: skipped, and reported", () => {
    expect(planPeopleFromTags(input({ tags: ["People/Twice"] }))).toEqual({ add: [], ambiguous: ["Twice"] });
  });
});
