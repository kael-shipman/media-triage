// `media-triage login <account>`: log in once with a password, and keep only the session (DESIGN.md, section 4).

import { type Account, type Config, ConfigError } from "../config.ts";
import { log } from "../log.ts";
import { ImmichClient, ImmichError, login } from "./client.ts";
import { loadSession, saveSession, sessionFile } from "./sessions.ts";

export interface LoginOutcome {
  account: Account;
  name: string;
  file: string;
  /** Whether it replaced (and ended) an earlier session. */
  replaced: boolean;
}

/** The configured account with this name. */
export function findAccount(config: Config, name: string): Account {
  const account = config.immich.accounts.find((candidate) => candidate.name === name);
  if (account) return account;
  const names = config.immich.accounts.map((candidate) => candidate.name);
  throw new ConfigError(
    names.length === 0
      ? `There's no account named "${name}": the configuration has no [[immich.accounts]].`
      : `There's no account named "${name}". The accounts are: ${names.join(", ")}.`,
  );
}

/** Logs an account in, checks the session, saves it, and ends the session it replaces. */
export async function loginAccount(config: Config, name: string, password: string): Promise<LoginOutcome> {
  const account = findAccount(config, name);
  const url = config.immich.url;
  if (!url) throw new ConfigError(`${config.file ?? "The configuration"} needs immich.url to log in.`);

  const session = await login(url, account.email, password);
  const me = await session.client.me();
  if (me.email.toLowerCase() !== account.email.toLowerCase()) {
    await session.client.logout();
    throw new ImmichError(`Logged in as ${me.email}, not ${account.email}`, 0);
  }
  if (account.admin && !session.isAdmin) {
    log.warn("the configuration says this account is the admin, but it isn't an admin in Immich", { account: name });
  }

  let previous;
  try {
    previous = loadSession(config.paths.state, name);
  } catch {
    // Unreadable or too open: it's replaced either way.
  }
  saveSession(config.paths.state, name, { token: session.token, userId: session.userId, email: me.email, created: new Date().toISOString() });

  if (previous && previous.token !== session.token) {
    try {
      await new ImmichClient(url, previous.token).logout();
    } catch (error) {
      // Already revoked, or expired: nothing to end.
      if (!(error instanceof ImmichError && error.status === 401)) log.warn("couldn't end the previous session", { account: name, error });
    }
  }
  return { account, name: me.name, file: sessionFile(config.paths.state, name), replaced: previous !== undefined };
}
