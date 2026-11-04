// Tests install.sh, run by `sh` (dash on Debian and Ubuntu), against a fake release server.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName } from "./upgrade.ts";

const installer = join(import.meta.dir, "..", "install.sh");
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** A stand-in for the real executable: answers `version`, and writes a config on `init`, unless one exists. */
const executable = (version: string) => `#!/bin/sh
case "$1" in
  version) echo "media-triage ${version}" ;;
  init) f="$XDG_CONFIG_HOME/media-triage/config.toml"; [ -e "$f" ] || { mkdir -p "$(dirname "$f")"; echo "# starter" > "$f"; } ;;
esac
`;

let badHash = false;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname, search } = new URL(request.url);
    if (pathname === "/api/v3/repos/owner/media-triage/releases/latest") return Response.json({ tag_name: "v1.1.0", assets: [] });
    if (pathname === "/api/v3/repos/owner/media-triage/releases" && search === "?per_page=1") return Response.json([{ tag_name: "v1.2.0-rc.1" }]);
    const download = /^\/owner\/media-triage\/releases\/download\/v([^/]+)\/(.+)$/.exec(pathname);
    if (download && ["1.0.0", "1.1.0", "1.2.0-rc.1"].includes(download[1]!)) {
      const body = executable(download[1]!);
      if (download[2] === "SHA256SUMS") return new Response(`${badHash ? "0".repeat(64) : sha256(body)}  ${assetName()}\n`);
      if (download[2] === assetName()) return new Response(body);
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

let dir: string;
let home: string;
let stubs: string;
beforeEach(() => {
  badHash = false;
  dir = mkdtempSync(join(tmpdir(), "media-triage-install-"));
  home = join(dir, "home");
  stubs = join(dir, "stubs");
  mkdirSync(home);
  mkdirSync(stubs);
  // systemctl records its arguments instead of touching the real system.
  writeFileSync(join(stubs, "systemctl"), `#!/bin/sh\necho "$*" >> "${join(dir, "systemctl.log")}"\n`, { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Asynchronous, so this process's fake server can answer the installer's downloads.
async function install(...args: string[]) {
  const child = Bun.spawn(["sh", installer, "--repo", `${server.url}owner/media-triage`, ...args], {
    env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { status, out, err };
}
const installedVersion = () => Bun.spawnSync([join(home, ".local/bin/media-triage"), "version"]).stdout.toString().trim();

test("installs the newest release into ~/.local/bin, with a starter configuration", async () => {
  const { status, out, err } = await install();
  expect(err).not.toContain("Error");
  expect(status).toBe(0);
  expect(out).toContain("Installed");
  expect(installedVersion()).toBe("media-triage 1.1.0");
  expect(statSync(join(home, ".local/bin/media-triage")).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(home, ".config/media-triage/config.toml"), "utf8")).toBe("# starter\n");
  expect(existsSync(join(dir, "systemctl.log"))).toBe(false);
});

test("--version and --prerelease choose the release; re-running replaces it and keeps the configuration", async () => {
  expect((await install()).status).toBe(0);
  writeFileSync(join(home, ".config/media-triage/config.toml"), "# mine\n");
  expect((await install("--version", "1.0.0")).status).toBe(0);
  expect(installedVersion()).toBe("media-triage 1.0.0");
  expect((await install("--prerelease")).status).toBe(0);
  expect(installedVersion()).toBe("media-triage 1.2.0-rc.1");
  expect(readFileSync(join(home, ".config/media-triage/config.toml"), "utf8")).toBe("# mine\n");
});

test("--prefix puts the executable elsewhere", async () => {
  expect((await install("--prefix", join(dir, "bin"))).status).toBe(0);
  expect(existsSync(join(dir, "bin/media-triage"))).toBe(true);
});

test("a checksum mismatch installs nothing", async () => {
  badHash = true;
  const { status, err } = await install();
  expect(status).toBe(1);
  expect(err).toContain("doesn't match its checksum");
  expect(existsSync(join(home, ".local/bin/media-triage"))).toBe(false);
});

test("a missing release is an error", async () => {
  const { status, err } = await install("--version", "v9.9.9");
  expect(status).toBe(1);
  expect(err).toContain("has no");
});

test("--service user writes a user unit and enables it, without starting it", async () => {
  const { status, out } = await install("--service", "user");
  expect(status).toBe(0);
  const unit = readFileSync(join(home, ".config/systemd/user/media-triage.service"), "utf8");
  expect(unit).toContain(`ExecStart=${join(home, ".local/bin/media-triage")} run`);
  expect(unit).toContain("Restart=always");
  expect(unit).toContain("WantedBy=default.target");
  expect(readFileSync(join(dir, "systemctl.log"), "utf8")).toBe(
    "--user daemon-reload\n--user enable media-triage.service\n--user try-restart media-triage.service\n",
  );
  expect(out).toContain("systemctl --user start media-triage");
});

test("bad options are errors", async () => {
  expect((await install("--service", "sometimes")).status).toBe(1);
  expect((await install("--bogus")).status).toBe(1);
  expect((await install("--help")).out).toContain("Usage: install.sh");
});
