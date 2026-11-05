// When an inbox unit is filed (DESIGN.md, section 7): it's tagged `Promote` and has a title, after the merge; no copy
// is in the trash and it isn't rejected; and it has settled: every copy agrees with the sidecar, and nothing about the
// unit changed for the settle time. Without a title, it gets `Promote/Needs a title` instead, so the problem shows in
// both tools.

import { NEEDS_TITLE_TAG, PROMOTE_TAG } from "./naming.ts";

/**
 * An inbox unit's tags with `Promote/Needs a title` where it's tagged `Promote` but has no title, and without it
 * everywhere else: the daemon's own tag, cleared once there's a title or no `Promote`.
 */
export function withNeedsTitle(tags: readonly string[], title: string | null): string[] {
  const others = tags.filter((tag) => tag !== NEEDS_TITLE_TAG);
  return (others.includes(PROMOTE_TAG) && title === null ? [...others, NEEDS_TITLE_TAG] : others).sort();
}

/** A copy, as readiness needs it. */
export interface CopyState {
  trashed: boolean;
  /** It holds what it would read from the sidecar. */
  inStep: boolean;
  /** It was asked to refresh and hasn't read the sidecar yet. */
  catchingUp: boolean;
  /** When it last changed (ms): its `updatedAt`. */
  changedAt: number;
}

export interface ReadinessInput {
  /** The merged tags, without the title. */
  tags: readonly string[];
  title: string | null;
  /** The sidecar's rating: -1 is Darktable's reject. */
  rating: number | undefined;
  copies: readonly CopyState[];
  /** Copies the daemon knows of but can't read now: their account isn't open. */
  unreadable: number;
  /** When the sidecar last changed (ms). */
  sidecarChangedAt: number;
  settleMs: number;
  now: number;
}

export type Readiness = { ready: true } | { ready: false; why: string; inMs?: number };

export function readiness(input: ReadinessInput): Readiness {
  if (!input.tags.includes(PROMOTE_TAG)) return { ready: false, why: "it isn't tagged Promote" };
  if (input.title === null) return { ready: false, why: "it has no title" };
  if (input.rating === -1) return { ready: false, why: "it's rejected" };
  if (input.copies.some((copy) => copy.trashed)) return { ready: false, why: "a copy is in the trash" };
  if (input.unreadable > 0) return { ready: false, why: "a copy's account isn't open, so its state can't be read" };
  if (input.copies.some((copy) => copy.catchingUp || !copy.inStep)) return { ready: false, why: "a copy hasn't read the sidecar yet" };
  const changedAt = Math.max(input.sidecarChangedAt, ...input.copies.map((copy) => copy.changedAt));
  const inMs = changedAt + input.settleMs - input.now;
  if (inMs > 0) return { ready: false, why: "it changed less than the settle time ago", inMs };
  return { ready: true };
}
