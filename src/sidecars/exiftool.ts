// exiftool, the daemon's one outside dependency (DESIGN.md, sections 9, 10 and 13).
//
// - One long-lived process (`-stay_open`), managed by exiftool-vendored, never a process per file.
// - A release always uses the system's exiftool. The Perl script exiftool-vendored brings can't run from inside a
//   Bun-compiled executable, and the executable would still find it by the path it had when it was built, which
//   exists only on the machine that built it. Running from source, that copy stands in when the system has none.
// - Every write uses `-overwrite_original`: exiftool's `*_original` backups would sync to every machine.
// - Fields are read and written by their group-qualified names, without MWG's composite tags (`useMWG: false`).

import { ExifTool, ExifToolTask, type WriteTags } from "exiftool-vendored";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Assignments, TAGS, type XmpFields, parseXmp } from "../core/xmp.ts";
import { IS_COMPILED } from "../version.ts";
import { exiftoolConfig } from "./namespace.ts";

/** exiftool isn't there, or doesn't run. */
export class ExiftoolMissing extends Error {}

const INSTALL = "Install it from the system's packages: Debian's and Ubuntu's is libimage-exiftool-perl (`sudo apt install libimage-exiftool-perl`).";

/** JSON, names with their group (`-G1`), structures whole (`-struct`), values without print conversion (`-n`). */
const READ_ARGS = ["-charset", "filename=utf8", "-json", "-G1", "-struct", "-n", ...Object.values(TAGS).map((tag) => `-${tag}`)];

/**
 * Reads the daemon's fields from one file. exiftool's JSON leaves out the quotes around any value that looks like a
 * number, so a title "1.50" would read as 1.5. Every number is kept as the text exiftool wrote instead, which is the
 * value as it is in the file. (Newer exiftools can quote them, with `-api StructFormat=JSONQ`, but 12.76, Ubuntu 24.04's,
 * ignores that.)
 */
class ReadTask extends ExifToolTask<Record<string, unknown>> {
  constructor(file: string) {
    super([...READ_ARGS, file]);
  }

  protected parse(input: string, error?: Error): Record<string, unknown> {
    if (error) throw error;
    if (this.errors.length > 0) throw new Error(this.errors.join("; "));
    const keepText = (_key: string, value: unknown, context?: { source?: string }) =>
      typeof value === "number" && context?.source !== undefined ? context.source : value;
    const [tags] = JSON.parse(input, keepText as (key: string, value: unknown) => unknown) as Record<string, unknown>[];
    if (!tags) throw new Error("exiftool read nothing");
    return tags;
  }
}

export interface FoundExiftool {
  path: string;
  /** Found on the PATH (in a release, the system's), or the copy exiftool-vendored brings (from source only). */
  source: "path" | "bundled";
}

/** Finds exiftool: the system's, on the PATH, or when running from source, the copy exiftool-vendored brings. */
export function findExiftool(options: { compiled?: boolean; which?: (command: string) => string | null } = {}): FoundExiftool {
  const system = (options.which ?? ((command) => Bun.which(command)))("exiftool");
  if (system) return { path: system, source: "path" };
  if (!(options.compiled ?? IS_COMPILED)) {
    try {
      const bundled = join(dirname(Bun.resolveSync("exiftool-vendored.pl/package.json", import.meta.dir)), "bin", "exiftool");
      if (existsSync(bundled)) return { path: bundled, source: "bundled" };
    } catch {
      // exiftool-vendored.pl isn't installed.
    }
  }
  throw new ExiftoolMissing(`exiftool isn't installed, or isn't on the PATH. ${INSTALL}`);
}

/**
 * Runs `exiftool -ver` once, to check that exiftool runs before starting the long-lived process: exiftool-vendored
 * would otherwise retry starting a missing or broken one without end.
 */
async function versionOf(path: string): Promise<string> {
  let output: string;
  let problem: string;
  try {
    const child = Bun.spawn([path, "-ver"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 30_000);
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    clearTimeout(timer);
    output = stdout.trim();
    problem = stderr.trim() || `it exited with status ${status}`;
    if (status === 0 && /^\d+\.\d+/.test(output)) return output;
  } catch (error) {
    problem = (error as Error).message;
  }
  throw new ExiftoolMissing(`exiftool at ${path} doesn't run: ${problem}. ${INSTALL}`);
}

/** A running exiftool, with the daemon's namespace defined. Close it when done. */
export class Exiftool {
  private constructor(
    private readonly process: ExifTool,
    private readonly configDir: string,
    readonly path: string,
    readonly source: FoundExiftool["source"],
    readonly version: string,
  ) {}

  /** Starts exiftool, by default the one `findExiftool` finds, after checking that it runs. */
  static async start(options: { path?: string } = {}): Promise<Exiftool> {
    const found: FoundExiftool = options.path ? { path: options.path, source: "path" } : findExiftool();
    const version = await versionOf(found.path);
    // exiftool reads the config when it starts, and exiftool-vendored starts it again every few hundred files, so the
    // config stays until close().
    const configDir = mkdtempSync(join(tmpdir(), "media-triage-exiftool-"));
    const config = join(configDir, "namespace.config");
    writeFileSync(config, exiftoolConfig());
    const process = new ExifTool({
      exiftoolPath: found.path,
      exiftoolArgs: ["-config", config, "-stay_open", "True", "-@", "-"],
      maxProcs: 1,
      useMWG: false,
      writeArgs: ["-overwrite_original"],
    });
    return new Exiftool(process, configDir, found.path, found.source, version);
  }

  /** The fields the daemon uses, from an XMP file. */
  async read(file: string): Promise<XmpFields> {
    try {
      return parseXmp(await this.process.enqueueTask(() => new ReadTask(file)));
    } catch (error) {
      throw new Error(`exiftool couldn't read ${file}: ${(error as Error).message}`);
    }
  }

  /**
   * Writes fields to an XMP file, creating it if there's none. exiftool writes a new file and renames it over the old
   * one, keeping its permissions.
   */
  async write(file: string, assignments: Assignments): Promise<void> {
    await this.process.write(file, assignments as WriteTags, { writeArgs: ["-overwrite_original"], useMWG: false });
  }

  async close(): Promise<void> {
    await this.process.end();
    rmSync(this.configDir, { recursive: true, force: true });
  }
}
