// People across the accounts (DESIGN.md, section 8): shared both ways with write access, and named in every account.
//
// Immich 3.3 gives each account its own record of a person, with its own name, and shows each account only that one:
// the web lists the others' names only as alternatives on the person's page (`otherPeople`), and the phone app not at
// all. Two things already keep names in step (`person.service.ts`, `update`, and the face it creates):
// - renaming a person also renames the records of the accounts that shared it with you with write access;
// - a record made for a shared person starts with the sharer's name.
// What's left are records that existed, unnamed, before the name was set or shared: upkeep copies the name onto them.

import { getPerson, listPeople, renamePeople, shareAllPeople } from "../immich/people.ts";
import { log } from "../log.ts";
import type { OpenAccount } from "./accounts.ts";

export interface PeopleOutcome {
  /** The accounts that shared their people with the others (or would have, in a dry run). */
  shared: string[];
  /** Names copied (or that would be), as `account: name`. */
  named: string[];
  /** People named differently in different accounts, left as they are where they're unnamed. */
  conflicts: { personId: string; names: string[] }[];
}

/**
 * Shares every account's people with the others, with write access, then copies names onto the records still
 * unnamed. Only accounts in one cluster group take part: Immich shares people only within one. Sharing runs on every
 * pass, since "share all" covers only the people that exist when it runs; repeating it changes nothing else.
 */
export async function upkeepPeople(accounts: readonly OpenAccount[], options: { dryRun: boolean }): Promise<PeopleOutcome> {
  const outcome: PeopleOutcome = { shared: [], named: [], conflicts: [] };
  if (accounts.length < 2) return outcome;

  for (const account of accounts) {
    const others = accounts.filter((other) => other !== account).map((other) => other.userId);
    if (!options.dryRun) await shareAllPeople(account.client, others);
    outcome.shared.push(account.account.name);
  }
  log.debug(`${options.dryRun ? "would share" : "shared"} people between the accounts`, { accounts: outcome.shared });

  // Every name each person has, across the accounts. Named people with a face are always listed.
  const names = new Map<string, Set<string>>();
  const namedIn = new Map<OpenAccount, Set<string>>();
  for (const account of accounts) {
    const named = new Set<string>();
    for (const person of await listPeople(account.client)) {
      if (person.name === "") continue;
      named.add(person.id);
      (names.get(person.id) ?? names.set(person.id, new Set()).get(person.id)!).add(person.name);
    }
    namedIn.set(account, named);
  }
  for (const [personId, found] of names) if (found.size > 1) outcome.conflicts.push({ personId, names: [...found].sort() });

  // Each account's own record of each person named elsewhere: read directly, since an unnamed record with few faces
  // isn't listed.
  for (const account of accounts) {
    const renames: { id: string; name: string }[] = [];
    for (const [personId, found] of names) {
      if (found.size !== 1 || namedIn.get(account)!.has(personId)) continue;
      const record = await getPerson(account.client, personId);
      if (record && record.name === "") renames.push({ id: personId, name: [...found][0]! });
    }
    if (renames.length === 0) continue;
    for (const { name } of renames) outcome.named.push(`${account.account.name}: ${name}`);
    log.info(`${options.dryRun ? "would copy" : "copying"} people's names`, { account: account.account.name, count: renames.length });
    if (options.dryRun) continue;
    for (const failure of await renamePeople(account.client, renames)) {
      log.warn("couldn't name a person", { account: account.account.name, person: failure.id, reason: failure.reason });
    }
  }
  for (const conflict of outcome.conflicts) log.warn("a person has different names in different accounts; copying neither", conflict);
  return outcome;
}
