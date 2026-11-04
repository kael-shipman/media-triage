// External libraries, and the accounts that own them (DESIGN.md, section 8). Every call here needs the admin's session.
//
// The daemon creates and corrects libraries, and scans them. It never deletes one.

import {
  type LibraryResponseDto,
  QueueName,
  type LibraryStatsResponseDto,
  type UserAdminResponseDto,
  type ValidateLibraryImportPathResponseDto,
  createLibrary as sdkCreateLibrary,
  getAllLibraries,
  getLibraryStatistics,
  getQueue,
  scanLibrary as sdkScanLibrary,
  searchUsersAdmin,
  updateLibrary as sdkUpdateLibrary,
  validate,
} from "@immich/sdk";
import { type ImmichClient, ImmichError } from "./client.ts";

export type Library = LibraryResponseDto;

/** Immich's limit on a library's import paths, and on its exclusion patterns (`dtos/library.dto.ts`). */
export const MAX_LIBRARY_LIST = 128;

export interface LibrarySettings {
  name: string;
  importPaths: readonly string[];
  exclusionPatterns: readonly string[];
}

/** Checks a list as Immich will: at most 128 items, none empty, none twice. */
function checkList(library: string, what: string, items: readonly string[]): string[] {
  if (items.length > MAX_LIBRARY_LIST) {
    throw new ImmichError(`Library "${library}": ${items.length} ${what}, but Immich allows at most ${MAX_LIBRARY_LIST}`, 0);
  }
  if (items.some((item) => item.trim() === "")) throw new ImmichError(`Library "${library}": an empty item in its ${what}`, 0);
  const repeated = items.find((item, index) => items.indexOf(item) !== index);
  if (repeated !== undefined) throw new ImmichError(`Library "${library}": "${repeated}" is twice in its ${what}`, 0);
  return [...items];
}

/** Every account's libraries. */
export function listLibraries(admin: ImmichClient): Promise<Library[]> {
  return admin.call("Listing libraries", (opts) => getAllLibraries(opts));
}

/** Creates a library for an account, which owns it from then on: Immich can't change a library's owner. */
export function createLibrary(admin: ImmichClient, ownerId: string, settings: LibrarySettings): Promise<Library> {
  const importPaths = checkList(settings.name, "import paths", settings.importPaths);
  const exclusionPatterns = checkList(settings.name, "exclusion patterns", settings.exclusionPatterns);
  return admin.call(`Creating library "${settings.name}"`, (opts) =>
    sdkCreateLibrary({ createLibraryDto: { ownerId, name: settings.name, importPaths, exclusionPatterns } }, opts),
  );
}

/** Changes a library's name, folders or exclusion patterns. What's left out stays as it is. */
export function updateLibrary(admin: ImmichClient, id: string, changes: Partial<LibrarySettings>): Promise<Library> {
  const label = changes.name ?? id;
  return admin.call(`Updating library "${label}"`, (opts) =>
    sdkUpdateLibrary(
      {
        id,
        updateLibraryDto: {
          name: changes.name,
          importPaths: changes.importPaths && checkList(label, "import paths", changes.importPaths),
          exclusionPatterns: changes.exclusionPatterns && checkList(label, "exclusion patterns", changes.exclusionPatterns),
        },
      },
      opts,
    ),
  );
}

/** Starts a scan: new files are added, changed ones re-read, and missing or newly excluded ones go offline. */
export async function scanLibrary(admin: ImmichClient, id: string): Promise<void> {
  await admin.call(`Scanning library ${id}`, (opts) => sdkScanLibrary({ id }, opts));
}

export function libraryStatistics(admin: ImmichClient, id: string): Promise<LibraryStatsResponseDto> {
  return admin.call(`Reading library ${id}'s statistics`, (opts) => getLibraryStatistics({ id }, opts));
}

/** Whether Immich can read each folder (`POST /api/libraries/{id}/validate`): it exists, is a folder, and is readable. */
export async function validateImportPaths(admin: ImmichClient, id: string, importPaths: readonly string[]): Promise<ValidateLibraryImportPathResponseDto[]> {
  const result = await admin.call(`Checking library ${id}'s folders`, (opts) =>
    validate({ id, validateLibraryDto: { importPaths: checkList(id, "import paths", importPaths) } }, opts),
  );
  return result.importPaths ?? [];
}

/** Every account on the server, for matching configured accounts to their user IDs. */
export function listUsers(admin: ImmichClient): Promise<UserAdminResponseDto[]> {
  return admin.call("Listing users", (opts) => searchUsersAdmin({}, opts));
}

/** Whether Immich's library queue is idle: no scan or import running, waiting or delayed (`GET /api/queues/library`). */
export async function libraryQueueIdle(admin: ImmichClient): Promise<boolean> {
  const queue = await admin.call("Reading the library queue", (opts) => getQueue({ name: QueueName.Library }, opts));
  const { active, waiting, delayed } = queue.statistics;
  return active + waiting + delayed === 0;
}

/**
 * Waits until the library queue has been idle twice in a row, a poll apart, so a scan that has only just been queued
 * isn't missed. Returns false if it's still busy after `timeoutMs`, or when `signal` aborts.
 */
export async function waitForLibraryQueue(admin: ImmichClient, timeoutMs: number, pollMs = 1000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let idleBefore = false;
  for (;;) {
    if (signal?.aborted) return false;
    const idle = await libraryQueueIdle(admin);
    if (idle && idleBefore) return true;
    idleBefore = idle;
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}
