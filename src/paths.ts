import { homedir } from "node:os";
import { join } from "node:path";

/** Expands a leading `~` to the home folder. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function defaultConfigPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return process.env.MEDIA_TRIAGE_CONFIG || join(configHome, "media-triage", "config.toml");
}

export function defaultStateDir(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "media-triage");
}
