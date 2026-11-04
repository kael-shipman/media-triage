// What Immich's bulk calls answer per item.

import { BulkIdErrorReason, type BulkIdResponseDto } from "@immich/sdk";

export interface BulkFailure {
  id: string;
  reason: string;
}

/**
 * The items that failed, leaving out the reasons that mean "already so", which an idempotent caller doesn't care
 * about: adding an asset that's already in an album, or removing one that isn't.
 */
export function failures(results: readonly BulkIdResponseDto[], alreadySo: readonly BulkIdErrorReason[] = []): BulkFailure[] {
  return results
    .filter((result) => !result.success && !(result.error && alreadySo.includes(result.error)))
    .map((result) => ({ id: result.id, reason: result.errorMessage ?? result.error ?? BulkIdErrorReason.Unknown }));
}
