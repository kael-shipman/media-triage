// People, their names, and sharing them between accounts (DESIGN.md, section 8).
//
// Sharing needs the accounts in one cluster group (`person.service.ts`, `upsertPeopleUsers`).

import {
  type PeopleUpdateItem,
  PeopleUsersUpsertType,
  type PersonResponseDto,
  PersonUserRole,
  type PersonUsersResponseDto,
  createPerson as sdkCreatePerson,
  getAllPeople,
  getPerson as sdkGetPerson,
  getUsersForPeople,
  updatePeople,
  upsertPeopleUsers,
} from "@immich/sdk";
import { chunks } from "./assets.ts";
import { type BulkFailure, failures } from "./bulk.ts";
import { type ImmichClient, ImmichError } from "./client.ts";

export type Person = PersonResponseDto;

/** People per page: Immich's maximum. */
const PEOPLE_PAGE = 1000;

/**
 * The account's people, hidden ones included (`GET /api/people`, page by page). Not all of them: only people with a
 * visible face on the account's own assets (or a partner's, or in a shared album), and of the unnamed ones only those
 * with at least the recognition's minimum of faces (`minFaces`, 3 by default) (`person.repository.ts`,
 * `getAllForUser`). Named people with a face are always listed. The sync stream's `PersonV1` reports every record.
 */
export async function listPeople(client: ImmichClient): Promise<Person[]> {
  const people: Person[] = [];
  for (let page = 1; ; page++) {
    const result = await client.call("Listing people", (opts) => getAllPeople({ withHidden: true, page, size: PEOPLE_PAGE }, opts));
    people.push(...result.people);
    if (!result.hasNextPage) return people;
  }
}

/** The account's own record of a person (`GET /api/people/{id}`), or undefined if it has none. */
export async function getPerson(client: ImmichClient, id: string): Promise<Person | undefined> {
  try {
    return await client.call(`Reading person ${id}`, (opts) => sdkGetPerson({ id }, opts));
  } catch (error) {
    // Immich answers 400 "Not found or no person.read access" for a person the account has no record of.
    if (error instanceof ImmichError && (error.status === 400 || error.status === 404) && /not found/i.test(error.message)) return undefined;
    throw error;
  }
}

export function createPerson(client: ImmichClient, name: string): Promise<Person> {
  return client.call(`Creating person "${name}"`, (opts) => sdkCreatePerson({ personCreateDto: { name } }, opts));
}

/** Renames people in the account's own records, in bulk (`PUT /api/people`). Returns the ones that failed. */
export async function renamePeople(client: ImmichClient, names: readonly { id: string; name: string }[]): Promise<BulkFailure[]> {
  const failed: BulkFailure[] = [];
  for (const piece of chunks(names, PEOPLE_PAGE)) {
    const people: PeopleUpdateItem[] = piece.map(({ id, name }) => ({ id, name }));
    failed.push(...failures(await client.call("Renaming people", (opts) => updatePeople({ peopleUpdateDto: { people } }, opts))));
  }
  return failed;
}

/**
 * Shares every person the account has now with these accounts (`PUT /api/people/users`, `type: everyone`). It covers
 * only the people that exist when it runs, so it's repeated on every pass. Write access by default.
 */
export async function shareAllPeople(client: ImmichClient, sharedWithIds: readonly string[], role: PersonUserRole = PersonUserRole.Write): Promise<void> {
  await client.call("Sharing people", (opts) =>
    upsertPeopleUsers({ peopleUsersUpsertDto: { type: PeopleUsersUpsertType.Everyone, sharedWithIds: [...sharedWithIds], role } }, opts),
  );
}

/** Who each of the account's people is shared with, and who shared people with it (`GET /api/people/users`). */
export function listPeopleShares(client: ImmichClient): Promise<PersonUsersResponseDto> {
  return client.call("Listing shared people", (opts) => getUsersForPeople({}, opts));
}
