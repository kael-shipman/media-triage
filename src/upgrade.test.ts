import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVersion } from "./semver.ts";
import { CHECKSUMS, assetName, parseChecksums, pickRelease, repoApi, type Release, upgrade } from "./upgrade.ts";

/** A stand-in executable: a shell script that prints a version, like `media-triage version` does. */
const script = (version: string) => `#!/bin/sh\necho "media-triage ${version}"\n`;
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

interface FakeRelease {
  tag: string;
  prerelease?: boolean;
  draft?: boolean;
  /** What the executable prints; defaults to the tag's version. */
  prints?: string;
  /** Overrides the hash listed in SHA256SUMS. */
  listedHash?: string;
}

let releases: FakeRelease[] = [];
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/v3/repos/owner/media-triage/releases") {
      return Response.json(
        releases.map((release) => ({
          tag_name: release.tag,
          draft: release.draft ?? false,
          prerelease: release.prerelease ?? false,
          assets: [assetName(), CHECKSUMS].map((name) => ({ name, browser_download_url: `${server.url}download/${release.tag}/${name}` })),
        })),
      );
    }
    const download = /^\/download\/([^/]+)\/(.+)$/.exec(pathname);
    const release = releases.find((candidate) => candidate.tag === download?.[1]);
    if (release) {
      const body = script(release.prints ?? parseVersion(release.tag)!.text);
      if (download![2] === CHECKSUMS) return new Response(`${release.listedHash ?? sha256(body)}  ${assetName()}\n`);
      return new Response(body);
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

const repo = `${server.url}owner/media-triage`;
let dir: string;
let executable: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  executable = join(dir, "media-triage");
  writeFileSync(executable, script("1.0.0"), { mode: 0o755 });
  releases = [{ tag: "v1.0.0" }, { tag: "v1.0.1" }, { tag: "v1.1.0" }, { tag: "v1.2.0-rc.1", prerelease: true }, { tag: "v2.0.0" }, { tag: "v9.0.0", draft: true }];
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

const request = (overrides: Partial<Parameters<typeof upgrade>[0]> = {}) =>
  upgrade({ repo, track: "minor", prerelease: false, executable, current: "1.0.0", ...overrides });
const installed = () => Bun.spawnSync([executable]).stdout.toString().trim();

describe("upgrade", () => {
  test("installs the newest release the track allows, checked and in place", async () => {
    expect(await request()).toEqual({ status: "upgraded", from: "1.0.0", to: "1.1.0" });
    expect(installed()).toBe("media-triage 1.1.0");
    expect(readdirSync(dir)).toEqual(["media-triage"]);
  });

  test("the track and pre-release settings decide how far it goes", async () => {
    expect(await request({ track: "patch", checkOnly: true })).toEqual({ status: "available", from: "1.0.0", to: "1.0.1" });
    expect(await request({ track: "major", checkOnly: true })).toEqual({ status: "available", from: "1.0.0", to: "2.0.0" });
    expect(await request({ prerelease: true, checkOnly: true })).toEqual({ status: "available", from: "1.0.0", to: "1.2.0-rc.1" });
  });

  test("checking changes nothing", async () => {
    await request({ checkOnly: true });
    expect(installed()).toBe("media-triage 1.0.0");
  });

  test("on the newest release, there's nothing to do", async () => {
    expect(await request({ current: "1.1.0" })).toEqual({ status: "current", from: "1.1.0" });
  });

  test("--to installs a given release, even an older one", async () => {
    expect(await request({ current: "1.1.0", to: "v1.0.1" })).toEqual({ status: "upgraded", from: "1.1.0", to: "1.0.1" });
    expect(installed()).toBe("media-triage 1.0.1");
    await expect(request({ to: "v3.0.0" })).rejects.toThrow("has no release v3.0.0");
  });

  test("a checksum mismatch leaves the old executable, and no leftovers", async () => {
    releases = [{ tag: "v1.1.0", listedHash: "0".repeat(64) }];
    await expect(request()).rejects.toThrow("doesn't match its checksum");
    expect(installed()).toBe("media-triage 1.0.0");
    expect(readdirSync(dir)).toEqual(["media-triage"]);
  });

  test("an executable that reports the wrong version isn't installed", async () => {
    releases = [{ tag: "v1.1.0", prints: "1.0.9" }];
    await expect(request()).rejects.toThrow("didn't start properly");
    expect(installed()).toBe("media-triage 1.0.0");
    expect(readdirSync(dir)).toEqual(["media-triage"]);
  });

  test("an executable it can't replace is an error before anything is downloaded", async () => {
    chmodSync(dir, 0o555);
    chmodSync(executable, 0o555);
    await expect(request()).rejects.toThrow("isn't writable");
    expect(existsSync(executable) && readFileSync(executable, "utf8")).toBe(script("1.0.0"));
  });

  test("the running version must be a release", async () => {
    await expect(request({ current: "0.0.0-dev." })).rejects.toThrow("isn't a release version");
  });
});

describe("helpers", () => {
  test("repoApi handles github.com and GitHub Enterprise", () => {
    expect(repoApi("https://github.com/kael-shipman/media-triage")).toEqual({ api: "https://api.github.com", owner: "kael-shipman", name: "media-triage" });
    expect(repoApi("https://github.com/kael-shipman/media-triage.git/")).toMatchObject({ name: "media-triage" });
    expect(repoApi("https://git.example.com/o/r")).toEqual({ api: "https://git.example.com/api/v3", owner: "o", name: "r" });
    expect(() => repoApi("https://github.com/only-owner")).toThrow("isn't a repository URL");
  });

  test("parseChecksums reads sha256sum's output", () => {
    const hash = "a".repeat(64);
    expect(parseChecksums(`${hash}  media-triage-linux-x64\n${hash.toUpperCase()} *media-triage-linux-arm64\nnoise\n`)).toEqual(
      new Map([
        ["media-triage-linux-x64", hash],
        ["media-triage-linux-arm64", hash],
      ]),
    );
  });

  test("pickRelease never picks an older or equal version", () => {
    const release = (tag: string): Release => ({ tag, version: parseVersion(tag)!, prerelease: false, assets: new Map() });
    expect(pickRelease([release("v1.0.0"), release("v0.9.0")], parseVersion("1.0.0")!, { track: "major", prerelease: true })).toBeUndefined();
  });
});
