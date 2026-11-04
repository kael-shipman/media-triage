// Darktable for the tests: run headless (under xvfb-run) on a copy of a photo, to have it rewrite the copy's sidecar
// the way it does when someone edits the photo. Everything it keeps goes in a throwaway folder: its library is in
// memory, and its configuration, cache, temporary files and home folder are made for the run and deleted after.
// It never sees the developer's own (`~/.config/darktable`).
//
// Tests that need it are skipped when Darktable or xvfb-run isn't installed (CI has neither).

import { describe } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DARKTABLE_AVAILABLE = Boolean(Bun.which("darktable") && Bun.which("xvfb-run"));

/** `describe`, skipped unless Darktable and xvfb-run are installed. */
export const describeDarktable = describe.skipIf(!DARKTABLE_AVAILABLE);

/** Darktable's version, as `darktable --version` prints it ("5.6.1"). */
export function darktableVersion(): string | undefined {
  const result = Bun.spawnSync(["darktable", "--version"]);
  return /darktable (\S+)/.exec(result.stdout.toString())?.[1];
}

/**
 * Imports `image` into a throwaway Darktable, runs `lua` with the image as `image` (Darktable's Lua API), and exits.
 * Darktable reads the image's sidecar when it imports it, and writes it again each time the image changes. Returns
 * the lines the Lua wrote with `log(...)`.
 */
export async function darktable(image: string, lua: string, timeoutMs = 60_000): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "media-triage-darktable-"));
  try {
    const folders = Object.fromEntries(["config", "cache", "tmp", "home"].map((name) => [name, join(dir, name)]));
    for (const folder of Object.values(folders)) mkdirSync(folder);
    const logFile = join(dir, "log.txt");
    writeFileSync(
      join(folders.config!, "luarc"),
      `local dt = require "darktable"
local out = io.open(os.getenv("MEDIA_TRIAGE_LOG"), "w")
local function log(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring(select(i, ...)) end
  out:write(table.concat(parts, " "), "\\n")
  out:flush()
end
local ok, err = pcall(function()
  local image = dt.database.import(os.getenv("MEDIA_TRIAGE_IMAGE"))
${lua}
end)
if not ok then log("ERROR", err) end
out:close()
-- Darktable writes sidecars as each change is made, so there's nothing to wait for.
os.exit(ok and 0 or 1)
`,
    );
    const child = Bun.spawn(
      ["xvfb-run", "-a", "darktable", "--library", ":memory:", "--configdir", folders.config!, "--cachedir", folders.cache!, "--tmpdir", folders.tmp!, "--disable-opencl"],
      {
        env: {
          ...process.env,
          HOME: folders.home!,
          XDG_CONFIG_HOME: join(folders.home!, ".config"),
          XDG_CACHE_HOME: join(folders.home!, ".cache"),
          XDG_DATA_HOME: join(folders.home!, ".local", "share"),
          MEDIA_TRIAGE_IMAGE: image,
          MEDIA_TRIAGE_LOG: logFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const [status, output] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    clearTimeout(timer);
    const lines = readFileSync(logFile, { encoding: "utf8", flag: "a+" }).split("\n").filter((line) => line !== "");
    if (status !== 0 || lines.some((line) => line.startsWith("ERROR"))) {
      throw new Error(`Darktable failed (status ${status}):\n${lines.join("\n")}\n${output.split("\n").slice(-20).join("\n")}`);
    }
    return lines;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
