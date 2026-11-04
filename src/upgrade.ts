import { accessSync, chmodSync, constants, existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Track } from "./config.ts";
import { compareVersions, parseVersion, trackAllows, type Version } from "./semver.ts";
import { VERSION } from "./version.ts";

export class UpgradeError extends Error {}

export interface Release {
  tag: string;
  version: Version;
  prerelease: boolean;
  /** Asset name → download URL. */
  assets: Map<string, string>;
}

export interface UpgradeRequest {
  /** The repository releases come from, e.g. https://github.com/owner/repo. */
  repo: string;
  track: Track;
  prerelease: boolean;
  /** The executable to replace. */
  executable: string;
  /** The running version. */
  current: string;
  /** Only report what's available. */
  checkOnly?: boolean;
  /** A specific release, older or newer, instead of the newest the track allows. */
  to?: string;
  fetch?: typeof fetch;
}

export type UpgradeResult =
  | { status: "current"; from: string }
  | { status: "available"; from: string; to: string }
  | { status: "upgraded"; from: string; to: string };

/** The file a release holds for this machine, e.g. "media-triage-linux-arm64". */
export function assetName(platform: string = process.platform, arch: string = process.arch): string {
  return `media-triage-${platform}-${arch}`;
}

export const CHECKSUMS = "SHA256SUMS";

/** The REST API for a repository URL: github.com's, or a GitHub Enterprise server's (`/api/v3`). */
export function repoApi(repoUrl: string): { api: string; owner: string; name: string } {
  const url = new URL(repoUrl);
  const [owner, name] = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  if (!owner || !name) throw new UpgradeError(`${repoUrl} isn't a repository URL like https://github.com/owner/repo`);
  const api = url.host === "github.com" ? "https://api.github.com" : `${url.protocol}//${url.host}/api/v3`;
  return { api, owner, name };
}

export async function fetchReleases(repoUrl: string, fetcher: typeof fetch = fetch): Promise<Release[]> {
  const { api, owner, name } = repoApi(repoUrl);
  const response = await fetcher(`${api}/repos/${owner}/${name}/releases?per_page=100`, {
    headers: { accept: "application/vnd.github+json", "user-agent": `media-triage/${VERSION}` },
  });
  if (!response.ok) throw new UpgradeError(`Listing ${repoUrl}'s releases failed: HTTP ${response.status}`);
  const body = (await response.json()) as {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    assets: { name: string; browser_download_url: string }[];
  }[];
  const releases: Release[] = [];
  for (const release of body) {
    const version = parseVersion(release.tag_name);
    if (release.draft || !version) continue;
    releases.push({
      tag: release.tag_name,
      version,
      prerelease: release.prerelease || version.prerelease.length > 0,
      assets: new Map(release.assets.map((asset) => [asset.name, asset.browser_download_url])),
    });
  }
  return releases;
}

/** The newest release an automatic upgrade may take, if any is newer than `current`. */
export function pickRelease(releases: Release[], current: Version, options: { track: Track; prerelease: boolean }): Release | undefined {
  return releases
    .filter((release) => options.prerelease || !release.prerelease)
    .filter((release) => trackAllows(options.track, current, release.version))
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}

/** Parses `sha256sum` output: "<hash>  <name>" (or "<hash> *<name>") per line. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

/**
 * Finds the release to move to and, unless only checking, installs it over `executable`. The new executable is
 * downloaded next to the old one, checked against the release's SHA256SUMS, run with `version` to check that it
 * starts and is the expected version, and only then renamed over the old one.
 */
export async function upgrade(request: UpgradeRequest): Promise<UpgradeResult> {
  const fetcher = request.fetch ?? fetch;
  const current = parseVersion(request.current);
  if (!current) throw new UpgradeError(`The running version, "${request.current}", isn't a release version`);

  const releases = await fetchReleases(request.repo, fetcher);
  let target: Release | undefined;
  if (request.to) {
    const wanted = parseVersion(request.to);
    target = wanted && releases.find((release) => compareVersions(release.version, wanted) === 0);
    if (!target) throw new UpgradeError(`${request.repo} has no release ${request.to}`);
    if (compareVersions(target.version, current) === 0) return { status: "current", from: current.text };
  } else {
    target = pickRelease(releases, current, request);
    if (!target) return { status: "current", from: current.text };
  }
  if (request.checkOnly) return { status: "available", from: current.text, to: target.version.text };

  const asset = assetName();
  const assetUrl = target.assets.get(asset);
  const checksumsUrl = target.assets.get(CHECKSUMS);
  if (!assetUrl) throw new UpgradeError(`Release ${target.tag} has no ${asset}`);
  if (!checksumsUrl) throw new UpgradeError(`Release ${target.tag} has no ${CHECKSUMS}`);

  const folder = dirname(request.executable);
  try {
    accessSync(folder, constants.W_OK);
    if (existsSync(request.executable)) accessSync(request.executable, constants.W_OK);
  } catch {
    throw new UpgradeError(`Can't replace ${request.executable}: it, or its folder, isn't writable by this user`);
  }

  const checksums = await download(fetcher, checksumsUrl);
  const expected = parseChecksums(await checksums.text()).get(asset);
  if (!expected) throw new UpgradeError(`${CHECKSUMS} in release ${target.tag} has no line for ${asset}`);

  const temporary = join(folder, `.${basename(request.executable)}.${process.pid}.new`);
  try {
    await Bun.write(temporary, await download(fetcher, assetUrl));
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(temporary).arrayBuffer()).digest("hex");
    if (actual !== expected) throw new UpgradeError(`${asset} from release ${target.tag} doesn't match its checksum`);
    chmodSync(temporary, 0o755);

    const check = Bun.spawnSync([temporary, "version"], { timeout: 30_000 });
    const reported = check.stdout.toString().trim();
    if (check.exitCode !== 0 || reported !== `media-triage ${target.version.text}`) {
      throw new UpgradeError(
        `The new executable didn't start properly: \`version\` printed "${reported}" with status ${check.exitCode}, ` +
          `not "media-triage ${target.version.text}"`,
      );
    }
    renameSync(temporary, request.executable);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { status: "upgraded", from: current.text, to: target.version.text };
}

async function download(fetcher: typeof fetch, url: string): Promise<Response> {
  const response = await fetcher(url, { headers: { "user-agent": `media-triage/${VERSION}` } });
  if (!response.ok) throw new UpgradeError(`Downloading ${url} failed: HTTP ${response.status}`);
  return response;
}
