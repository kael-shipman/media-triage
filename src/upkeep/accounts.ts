// Opening each configured account's session, for account upkeep and the rest of the daemon (DESIGN.md, section 4).

import type { Account, Config } from "../config.ts";
import { ImmichClient, ImmichError } from "../immich/client.ts";
import { SessionError, loadSession } from "../immich/sessions.ts";

/** An account whose session works. */
export interface OpenAccount {
  account: Account;
  client: ImmichClient;
  userId: string;
  email: string;
  isAdmin: boolean;
  clusterGroupId: string;
}

/** An account that can't be used, and what to do about it. */
export interface AccountProblem {
  account: Account;
  problem: string;
}

export interface Accounts {
  /** In the configuration's order. */
  open: OpenAccount[];
  problems: AccountProblem[];
}

/**
 * Opens every configured account's session and checks it with `GET /api/users/me`. An account without a working
 * session is a problem, reported with what to do. Immich being unreachable isn't: it throws, since no account can
 * work then.
 */
export async function openAccounts(config: Config): Promise<Accounts> {
  const url = config.immich.url;
  if (!url) throw new ImmichError(`${config.file ?? "The configuration"} needs immich.url`, 0);
  const result: Accounts = { open: [], problems: [] };
  for (const account of config.immich.accounts) {
    const relogin = `log in again with \`media-triage login ${account.name}\``;
    let session;
    try {
      session = loadSession(config.paths.state, account.name);
    } catch (error) {
      if (!(error instanceof SessionError)) throw error;
      result.problems.push({ account, problem: error.message });
      continue;
    }
    if (!session) {
      result.problems.push({ account, problem: `not logged in: run \`media-triage login ${account.name}\`` });
      continue;
    }
    const client = new ImmichClient(url, session.token);
    let me;
    try {
      me = await client.me();
    } catch (error) {
      if (error instanceof ImmichError && error.status === 401) {
        result.problems.push({ account, problem: `its session was revoked or has expired: ${relogin}` });
        continue;
      }
      throw error;
    }
    if (me.email.toLowerCase() !== account.email.toLowerCase()) {
      result.problems.push({ account, problem: `its session is ${me.email}'s, but the configuration says ${account.email}: ${relogin}` });
      continue;
    }
    result.open.push({ account, client, userId: me.id, email: me.email, isAdmin: me.isAdmin, clusterGroupId: me.clusterGroupId });
  }
  return result;
}
