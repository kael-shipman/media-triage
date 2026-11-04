import type { Track } from "./config.ts";

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers: "rc.1" is ["rc", "1"]. Empty for a release. */
  prerelease: string[];
  /** The version as written, without a leading "v" or build metadata. */
  text: string;
}

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses "1.2.3", "v1.2.3" or "1.2.3-rc.1"; anything else gives undefined. */
export function parseVersion(text: string): Version | undefined {
  const match = PATTERN.exec(text.trim());
  if (!match) return undefined;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const prerelease = match[4] ? match[4].split(".") : [];
  const core = `${major}.${minor}.${patch}`;
  return { major, minor, patch, prerelease, text: prerelease.length ? `${core}-${prerelease.join(".")}` : core };
}

/** Semantic-versioning precedence: negative if a is older than b, positive if newer, zero if equal. */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return (a.prerelease.length === 0 ? 1 : 0) - (b.prerelease.length === 0 ? 1 : 0);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const [x, y] = [a.prerelease[index], b.prerelease[index]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [xNumeric, yNumeric] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumeric && yNumeric && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether an automatic upgrade from `current` may go to `candidate`. */
export function trackAllows(track: Track, current: Version, candidate: Version): boolean {
  if (compareVersions(candidate, current) <= 0) return false;
  switch (track) {
    case "patch":
      return candidate.major === current.major && candidate.minor === current.minor;
    case "minor":
      return candidate.major === current.major;
    case "major":
      return true;
  }
}
