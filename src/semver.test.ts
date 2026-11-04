import { describe, expect, test } from "bun:test";
import { compareVersions, parseVersion, trackAllows } from "./semver.ts";

const v = (text: string) => parseVersion(text)!;

describe("parseVersion", () => {
  test("reads releases and pre-releases, with or without a v", () => {
    expect(v("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], text: "1.2.3" });
    expect(v("1.2.3-rc.1+build.5")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ["rc", "1"], text: "1.2.3-rc.1" });
  });

  test.each(["", "1.2", "1.2.3.4", "v1.x.3", "0.0.0-dev.", "latest"])("rejects %p", (text) => {
    expect(parseVersion(text)).toBeUndefined();
  });
});

describe("compareVersions", () => {
  // In ascending order, as semver.org's example has it.
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];

  test("orders versions by precedence", () => {
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(v(ordered[i]!), v(ordered[i + 1]!))).toBeLessThan(0);
      expect(compareVersions(v(ordered[i + 1]!), v(ordered[i]!))).toBeGreaterThan(0);
    }
    expect(compareVersions(v("v1.2.3"), v("1.2.3"))).toBe(0);
  });
});

describe("trackAllows", () => {
  const current = v("1.2.3");
  test.each([
    ["patch", "1.2.4", true],
    ["patch", "1.3.0", false],
    ["minor", "1.3.0", true],
    ["minor", "2.0.0", false],
    ["major", "2.0.0", true],
    ["major", "1.2.3", false],
    ["major", "1.2.2", false],
  ] as const)("%p track, %p: %p", (track, candidate, allowed) => {
    expect(trackAllows(track, current, v(candidate))).toBe(allowed);
  });
});
