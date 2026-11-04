// Every configured account in one cluster group, the first account's (DESIGN.md, section 8).

import { log } from "../log.ts";
import { acceptClusterGroupInvitation, clusterGroupOf, inviteToClusterGroup } from "../immich/cluster-groups.ts";
import type { AccountProblem, OpenAccount } from "./accounts.ts";

export interface ClusterOutcome {
  /** The accounts in the first account's group (with `dryRun`, also those that would join), by name. */
  inGroup: Set<string>;
  /** The accounts that joined (or would have) in this pass. */
  joined: string[];
  problems: AccountProblem[];
}

/**
 * Brings every open account into the first configured account's cluster group: the first account invites it, and it
 * accepts with its own session. Joining keeps its people and their names. An account that isn't in the group by the
 * end mustn't get its libraries yet, or its faces would cluster into people of their own.
 */
export async function joinClusterGroup(
  firstAccountName: string | undefined,
  accounts: readonly OpenAccount[],
  options: { dryRun: boolean },
): Promise<ClusterOutcome> {
  const outcome: ClusterOutcome = { inGroup: new Set(), joined: [], problems: [] };
  const first = accounts.find((open) => open.account.name === firstAccountName);
  if (!first) {
    for (const open of accounts) {
      outcome.problems.push({ account: open.account, problem: `can't join the first account's cluster group: "${firstAccountName}" isn't logged in` });
    }
    return outcome;
  }
  const groupId = first.clusterGroupId;
  outcome.inGroup.add(first.account.name);
  for (const open of accounts) {
    if (open === first) continue;
    if (open.clusterGroupId === groupId) {
      outcome.inGroup.add(open.account.name);
      continue;
    }
    if (options.dryRun) {
      log.info("would join the cluster group", { account: open.account.name, of: first.account.name });
      outcome.inGroup.add(open.account.name);
      outcome.joined.push(open.account.name);
      continue;
    }
    try {
      const request = await inviteToClusterGroup(first.client, groupId, open.userId);
      await acceptClusterGroupInvitation(open.client, request.id);
      const now = await clusterGroupOf(open.client);
      if (now !== groupId) throw new Error(`it's in cluster group ${now} after accepting, not ${groupId}`);
      open.clusterGroupId = now;
      log.info("joined the cluster group", { account: open.account.name, of: first.account.name });
      outcome.inGroup.add(open.account.name);
      outcome.joined.push(open.account.name);
    } catch (error) {
      outcome.problems.push({ account: open.account, problem: `couldn't join ${first.account.name}'s cluster group: ${(error as Error).message}` });
    }
  }
  return outcome;
}
