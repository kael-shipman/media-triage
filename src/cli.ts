import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import exampleConfig from "../examples/config.toml" with { type: "text" };
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { formatDuration } from "./duration.ts";
import { LEVELS, type Level, log, setLogLevel } from "./log.ts";
import { defaultConfigPath } from "./paths.ts";
import { VERSION } from "./version.ts";

/** Exit statuses. */
export const EXIT = { ok: 0, error: 1, usage: 2 } as const;

const HELP = `media-triage ${VERSION}
Keeps a photo inbox, an archive, Immich and Darktable in step, and files triaged photos.

Usage: media-triage <command> [options]

Commands:
  run        Run the daemon
  init       Write a starter configuration, unless there's one already
  config     Check the configuration, and print it with the defaults filled in
  version    Print the version
  help       Print this help

Options:
  --config FILE      The configuration file (default: ${defaultConfigPath()})
  --dry-run          (run) Do everything except changing anything
  --log-level LEVEL  debug, info, warn or error (default: the configuration's, or info)

Documentation: https://github.com/kael-shipman/media-triage`;

const OPTIONS = {
  config: { type: "string" },
  "dry-run": { type: "boolean" },
  "log-level": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

/** Which options each command accepts, besides --config, --log-level and --help. */
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  run: ["dry-run"],
  init: [],
  config: [],
  version: [],
  help: [],
};

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return usage((error as Error).message);
  }
  const { values, positionals } = parsed;

  if (values.version) return printVersion();
  const command = values.help ? "help" : (positionals[0] ?? "help");
  if (!(command in COMMAND_OPTIONS)) return usage(`Unknown command: ${command}`);
  if (positionals.length > 1) return usage(`Unexpected argument: ${positionals[1]}`);
  for (const option of ["dry-run"] as const) {
    if (values[option] !== undefined && !COMMAND_OPTIONS[command]!.includes(option)) {
      return usage(`--${option} doesn't apply to ${command}`);
    }
  }
  const logLevel = values["log-level"];
  if (logLevel !== undefined && !LEVELS.includes(logLevel as Level)) {
    return usage(`--log-level must be one of ${LEVELS.join(", ")}`);
  }
  if (logLevel) setLogLevel(logLevel as Level);

  const configFile = values.config ?? defaultConfigPath();

  try {
    switch (command) {
      case "help":
        console.log(HELP);
        return EXIT.ok;
      case "version":
        return printVersion();
      case "init":
        return init(configFile);
      case "config":
        return showConfig(loadConfig(configFile));
      case "run": {
        const config = loadConfig(configFile);
        if (!logLevel) setLogLevel(config.log.level);
        return await runDaemon(config, { dryRun: values["dry-run"] ?? false });
      }
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error(error.message);
      return EXIT.error;
    }
    throw error;
  }
  return EXIT.ok;
}

/** Prints "media-triage <version>". Upgrades rely on this exact form to check a new executable. */
function printVersion(): number {
  console.log(`media-triage ${VERSION}`);
  return EXIT.ok;
}

function usage(problem: string): number {
  console.error(`${problem}\nRun \`media-triage help\` for the commands and options.`);
  return EXIT.usage;
}

function init(file: string): number {
  if (existsSync(file)) {
    console.log(`${file} already exists; leaving it as it is.`);
    return EXIT.ok;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, exampleConfig, { mode: 0o600 });
  console.log(`Wrote a starter configuration to ${file}. Edit it, then check it with \`media-triage config\`.`);
  return EXIT.ok;
}

function showConfig(config: Config): number {
  const { timing, upgrade, ...rest } = config;
  const readable = {
    ...rest,
    timing: { settle: formatDuration(timing.settleMs), orphanGrace: formatDuration(timing.orphanGraceMs), fullPass: formatDuration(timing.fullPassMs) },
    upgrade: { ...upgrade, intervalMs: undefined, interval: formatDuration(upgrade.intervalMs) },
  };
  console.log(JSON.stringify(readable, null, 2));
  return EXIT.ok;
}
