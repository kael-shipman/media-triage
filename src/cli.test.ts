import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "main.ts");
let dir: string | undefined;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, main, ...args], { env: { ...process.env, JOURNAL_STREAM: "" } });
  return { status: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("version prints exactly 'media-triage <version>'", () => {
  expect(run("version").out).toMatch(/^media-triage \S+\n$/);
  expect(run("--version").out).toMatch(/^media-triage \S+\n$/);
});

test("help lists the commands", () => {
  const { status, out } = run("help");
  expect(status).toBe(0);
  for (const command of ["run", "init", "config", "version"]) expect(out).toContain(`  ${command} `);
});

test("usage mistakes exit with status 2", () => {
  expect(run("bogus").status).toBe(2);
  expect(run("config", "--dry-run").status).toBe(2);
  expect(run("--no-such-option").status).toBe(2);
  expect(run("run", "extra").status).toBe(2);
});

test("init writes the example once, privately, and never overwrites", () => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  const file = join(dir, "sub", "config.toml");
  expect(run("init", "--config", file).status).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(readFileSync(join(import.meta.dir, "..", "examples", "config.toml"), "utf8"));
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(run("init", "--config", file).out).toContain("already exists");
});

test("config reports a bad configuration with status 1", () => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  const file = join(dir, "config.toml");
  writeFileSync(file, "[paths]\ninbx = 1\n");
  const { status, err } = run("config", "--config", file);
  expect(status).toBe(1);
  expect(err).toContain("Unknown setting: paths.inbx");
});

test("run starts, and stops cleanly on SIGTERM", async () => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  const file = join(dir, "config.toml");
  const example = readFileSync(join(import.meta.dir, "..", "examples", "config.toml"), "utf8");
  writeFileSync(file, example.replace('# state = "~/.local/state/media-triage"', `state = "${join(dir, "state")}"`));
  const daemon = Bun.spawn([process.execPath, main, "run", "--config", file], { stdout: "pipe", env: { ...process.env, JOURNAL_STREAM: "" } });
  const reader = daemon.stdout.getReader();
  let out = "";
  while (!out.includes("media-triage starting")) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  daemon.kill("SIGTERM");
  expect(await daemon.exited).toBe(0);
  expect(statSync(join(dir, "state", "state.sqlite")).isFile()).toBe(true);
});

test("sidecar prints what's read from a sidecar, given it or its media file", () => {
  dir = mkdtempSync(join(tmpdir(), "media-triage-"));
  const fixtures = join(import.meta.dir, "..", "test", "fixtures");
  copyFileSync(join(fixtures, "darktable.xmp"), join(dir, "photo.jpg.xmp"));
  for (const file of [join(dir, "photo.jpg"), join(dir, "photo.jpg.xmp")]) {
    const { status, out } = run("sidecar", file);
    expect(status).toBe(0);
    const report = JSON.parse(out);
    expect(report.sidecar).toBe(join(dir, "photo.jpg.xmp"));
    expect(report.fields.title).toBe("Lake day");
    expect(report.darktableReads.tags).toEqual(["People/Robin Example", "Places/Lake"]);
    expect(report.exiftool.version).toMatch(/^\d+\.\d+/);
  }
  const missing = run("sidecar", join(dir, "other.jpg"));
  expect(missing.status).toBe(1);
  expect(missing.err).toContain("There's no sidecar");
});
