import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import exampleConfig from "../examples/config.toml" with { type: "text" };
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { formatDuration } from "./duration.ts";
import { EXIT } from "./exit.ts";
import { ImmichError } from "./immich/client.ts";
import { findAccount, loginAccount } from "./immich/login.ts";
import { listLibraries } from "./immich/libraries.ts";
import { SessionError } from "./immich/sessions.ts";
import { LEVELS, type Level, log, setLogLevel } from "./log.ts";
import { defaultConfigPath } from "./paths.ts";
import { PromptCancelled, readPassword } from "./prompt.ts";
import { darktableReads, immichReads } from "./core/xmp.ts";
import { Exiftool, ExiftoolMissing } from "./sidecars/exiftool.ts";
import { readSidecar } from "./sidecars/sidecar.ts";
import { openAccounts } from "./upkeep/accounts.ts";
import { checkLibraries, formatReport } from "./upkeep/check.ts";
import { UpgradeError, upgrade } from "./upgrade.ts";
import { IS_COMPILED, VERSION } from "./version.ts";

const HELP = `media-triage ${VERSION}
Keeps a photo inbox, an archive, Immich and Darktable in step, and files triaged photos.

Usage: media-triage <command> [options]

Commands:
  run              Run the daemon
  login ACCOUNT    Log an Immich account in, with its password, and keep the session
  check            Check that each library limited by date holds exactly what its date allows
  sidecar FILE     Print what media-triage reads from a sidecar: FILE, or FILE.xmp for a media file
  init             Write a starter configuration, unless there's one already
  config           Check the configuration, and print it with the defaults filled in
  upgrade          Upgrade to the newest release the configuration's [upgrade] track allows
  version          Print the version
  help             Print this help

Options:
  --config FILE      The configuration file (default: ${defaultConfigPath()})
  --dry-run          (run) Do everything except changing anything
  --check            (upgrade) Only report whether there's a newer release
  --to VERSION       (upgrade) Install this release instead, even an older one
  --log-level LEVEL  debug, info, warn or error (default: the configuration's, or info)

Documentation: https://github.com/kael-shipman/media-triage`;

const OPTIONS = {
  config: { type: "string" },
  "dry-run": { type: "boolean" },
  check: { type: "boolean" },
  to: { type: "string" },
  "log-level": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

/** Which arguments each command takes. */
const COMMAND_ARGUMENTS: Record<string, readonly string[]> = { login: ["ACCOUNT"], sidecar: ["FILE"] };

/** Which options each command accepts, besides --config, --log-level and --help. */
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  run: ["dry-run"],
  login: [],
  check: [],
  sidecar: [],
  init: [],
  config: [],
  upgrade: ["check", "to"],
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
  if (values.help) {
    console.log(HELP);
    return EXIT.ok;
  }
  const command = positionals[0] ?? "help";
  if (!(command in COMMAND_OPTIONS)) return usage(`Unknown command: ${command}`);
  const expected = COMMAND_ARGUMENTS[command] ?? [];
  const args = positionals.slice(1);
  if (args.length > expected.length) return usage(`Unexpected argument: ${args[expected.length]}`);
  if (args.length < expected.length) return usage(`${command} needs ${expected.slice(args.length).join(" and ")}`);
  for (const option of ["dry-run", "check", "to"] as const) {
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
      case "upgrade":
        return await upgradeNow(loadConfig(configFile, { optional: true }), { check: values.check ?? false, to: values.to });
      case "login":
        return await loginNow(loadConfig(configFile), args[0]!);
      case "check":
        return await checkNow(loadConfig(configFile));
      case "sidecar":
        return await showSidecar(args[0]!);
      case "run": {
        const config = loadConfig(configFile);
        if (!logLevel) setLogLevel(config.log.level);
        return await runDaemon(config, { dryRun: values["dry-run"] ?? false });
      }
    }
  } catch (error) {
    if (error instanceof PromptCancelled) return EXIT.error;
    if (error instanceof ConfigError || error instanceof UpgradeError || error instanceof ImmichError || error instanceof SessionError || error instanceof ExiftoolMissing) {
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

async function loginNow(config: Config, name: string): Promise<number> {
  const account = findAccount(config, name);
  const password = await readPassword(`Password for ${account.email} on ${config.immich.url ?? "Immich"}: `);
  if (password === "") {
    log.error("No password given");
    return EXIT.error;
  }
  const outcome = await loginAccount(config, name, password);
  console.log(
    `Logged in as ${outcome.name} (${outcome.account.email}). The session is in ${outcome.file}` +
      (outcome.replaced ? ", replacing the earlier one, which is ended." : ".") +
      "\nIt shows as media-triage in the account's Authorized devices, where it can be revoked.",
  );
  return EXIT.ok;
}

/** `media-triage check`: prints the report, and exits with 1 if anything failed or couldn't be checked. */
async function checkNow(config: Config): Promise<number> {
  const accounts = await openAccounts(config);
  for (const { account, problem } of accounts.problems) log.warn("account skipped", { account: account.name, problem });
  const admin = accounts.open.find((open) => open.account.admin);
  if (!admin) {
    log.error("The check needs the admin account's session, to find the libraries: configure one with admin = true, and log it in.");
    return EXIT.error;
  }
  const report = await checkLibraries(config, accounts.open, await listLibraries(admin.client));
  console.log(formatReport(report).join("\n"));
  return report.ok ? EXIT.ok : EXIT.error;
}

/**
 * `media-triage sidecar FILE`: the fields the daemon reads from a sidecar, and what Immich and Darktable each read from
 * them. It needs no configuration, and it's how CI checks that a release finds the system's exiftool.
 */
async function showSidecar(file: string): Promise<number> {
  const path = /\.xmp$/i.test(file) ? file : `${file}.xmp`;
  const exiftool = await Exiftool.start();
  try {
    const sidecar = await readSidecar(exiftool, path);
    if (!sidecar) {
      log.error(`There's no sidecar at ${path}`);
      return EXIT.error;
    }
    const report = {
      sidecar: path,
      exiftool: { version: exiftool.version, path: exiftool.path, source: exiftool.source },
      fields: sidecar.fields,
      immichReads: immichReads(sidecar.fields),
      darktableReads: darktableReads(sidecar.fields),
    };
    console.log(JSON.stringify(report, null, 2));
    return EXIT.ok;
  } finally {
    await exiftool.close();
  }
}

async function upgradeNow(config: Config, options: { check: boolean; to?: string }): Promise<number> {
  if (!options.check && !IS_COMPILED) {
    log.error("This runs from source, so there's no executable to upgrade. `--check` still works.");
    return EXIT.error;
  }
  const result = await upgrade({
    ...config.upgrade,
    executable: process.execPath,
    current: IS_COMPILED ? VERSION : "0.0.0",
    checkOnly: options.check,
    to: options.to,
  });
  switch (result.status) {
    case "current":
      console.log(`media-triage ${VERSION} is the newest release the "${config.upgrade.track}" track allows.`);
      break;
    case "available":
      console.log(`media-triage ${result.to} is available (running ${VERSION}). Install it with \`media-triage upgrade\`.`);
      break;
    case "upgraded":
      console.log(`Upgraded media-triage from ${result.from} to ${result.to}. If it runs as a service, restart it to use the new version.`);
      break;
  }
  return EXIT.ok;
}
