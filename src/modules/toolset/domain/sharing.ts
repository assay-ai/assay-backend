import { randomBytes } from 'node:crypto';

/**
 * Sharing a toolset: the visibility state machine of design spec §7.7
 * ("Lifecycle and state machine") and which URL kinds each state serves (§7.4,
 * "Resolution rules").
 *
 * Pure: every transition takes the current state and returns the next one.
 * `ToolsetPublishingService` (the owner) and the operator moderation service
 * write what this returns; the endpoint resolver and the public catalogue ask
 * the predicates.
 *
 * | Action             | By       | visibility | listing  | old URLs                                         |
 * |--------------------|----------|------------|----------|--------------------------------------------------|
 * | share UNLISTED     | owner    | UNLISTED   | —        | from PUBLIC: `/@…` serves until grace_until      |
 * | share PUBLIC       | owner    | PUBLIC     | LISTED¹  | the `/u/` link keeps working if it existed       |
 * | stop sharing       | owner    | PRIVATE    | —        | `/@…` or `/u/…` serve until grace_until          |
 * | rotate link        | owner    | unchanged  | —        | the old link dies at once                        |
 * | delist             | operator | PUBLIC     | DELISTED | out of the catalogue at once; URLs until grace   |
 * | take down          | operator | unchanged  | unchanged| `removed_at`: nothing but `/my/` serves, no grace|
 * | delete             | owner    | PRIVATE    | —        | as stop sharing when others use it, else nothing |
 *
 * ¹ DELISTED while an operator's delist stands (`delisted_at`): an owner
 *   cannot relist by stopping and sharing again.
 *
 * `grace_visibility` records which URL kind keeps serving during a grace
 * period: `UNLISTED` keeps the `/u/` link; `PUBLIC` keeps the `/@…` URLs and,
 * when the toolset had one, its `/u/` link.
 */

export enum ToolsetVisibility {
  PRIVATE = 'PRIVATE',
  UNLISTED = 'UNLISTED',
  PUBLIC = 'PUBLIC',
}

export enum ListingStatus {
  LISTED = 'LISTED',
  DELISTED = 'DELISTED',
}

/** How long old URLs keep serving after sharing ends, a delist or a delete (§7.4). */
export const SHARING_GRACE_MS = 90 * 24 * 60 * 60 * 1000;

/** The columns of `toolsets` this state machine owns. */
export interface SharingState {
  readonly visibility: ToolsetVisibility;
  readonly listingStatus: ListingStatus | null;
  readonly graceVisibility: ToolsetVisibility.UNLISTED | ToolsetVisibility.PUBLIC | null;
  readonly graceUntil: Date | null;
  readonly unlistedToken: string | null;
  readonly removedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly delistedAt: Date | null;
  readonly firstSharedAt: Date | null;
}

export type SharingAction =
  | { readonly kind: 'SHARE'; readonly visibility: ToolsetVisibility }
  | { readonly kind: 'STOP' }
  | { readonly kind: 'ROTATE' }
  | { readonly kind: 'DELIST' }
  | { readonly kind: 'RELIST' }
  | { readonly kind: 'TAKEDOWN' }
  | { readonly kind: 'RESTORE' }
  | { readonly kind: 'DELETE'; readonly usedByOthers: boolean }
  | { readonly kind: 'EXPIRE_GRACE' };

export type SharingRefusal =
  /** Taken down: only the owner's `/my/` serves, and nothing can be shared. */
  | 'TAKEN_DOWN'
  | 'DELETED'
  /** Rotating a link needs a shared toolset. */
  | 'NOT_SHARED'
  /** Delisting needs a PUBLIC, LISTED toolset; relisting a delisted one. */
  | 'NOT_LISTED'
  | 'NOT_DELISTED'
  | 'ALREADY_TAKEN_DOWN'
  | 'NOT_TAKEN_DOWN';

export class SharingTransitionError extends Error {
  constructor(readonly refusal: SharingRefusal) {
    super(refusal);
  }
}

/**
 * A new unlisted token: 130 random bits as 26 base32 characters, lowercase
 * because MCP paths are lowercased before routing (`parseMcpUrl`).
 */
export function newUnlistedToken(random: (bytes: number) => Buffer = randomBytes): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = random(17);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The next state, or a {@link SharingTransitionError}. */
export function applySharing(
  state: SharingState,
  action: SharingAction,
  now: Date,
  token: () => string = newUnlistedToken,
): SharingState {
  const graceEnd = new Date(now.getTime() + SHARING_GRACE_MS);

  switch (action.kind) {
    case 'SHARE': {
      if (state.removedAt) throw new SharingTransitionError('TAKEN_DOWN');
      if (state.deletedAt) throw new SharingTransitionError('DELETED');
      if (action.visibility === ToolsetVisibility.PRIVATE) {
        return isShared(state) ? applySharing(state, { kind: 'STOP' }, now, token) : state;
      }
      const firstSharedAt = state.firstSharedAt ?? now;
      if (action.visibility === ToolsetVisibility.UNLISTED) {
        const fromPublic = state.visibility === ToolsetVisibility.PUBLIC;
        const publicGrace =
          state.graceVisibility === ToolsetVisibility.PUBLIC && inGrace(state, now);
        return {
          ...state,
          visibility: ToolsetVisibility.UNLISTED,
          listingStatus: null,
          // The `/@…` URLs of a PUBLIC toolset keep serving for 90 days, and a
          // grace period they already had is not cut short.
          graceVisibility: fromPublic || publicGrace ? ToolsetVisibility.PUBLIC : null,
          graceUntil: fromPublic
            ? earlier(state.graceUntil, graceEnd)
            : publicGrace
              ? state.graceUntil
              : null,
          unlistedToken: state.unlistedToken ?? token(),
          firstSharedAt,
        };
      }
      const delisted = state.delistedAt !== null;
      return {
        ...state,
        visibility: ToolsetVisibility.PUBLIC,
        listingStatus: delisted ? ListingStatus.DELISTED : ListingStatus.LISTED,
        // A standing delist keeps its own grace period; nothing else needs one.
        graceVisibility: delisted ? ToolsetVisibility.PUBLIC : null,
        graceUntil: delisted ? (state.graceUntil ?? graceEnd) : null,
        firstSharedAt,
      };
    }

    case 'STOP': {
      if (!isShared(state)) return state;
      const kind =
        state.visibility === ToolsetVisibility.PUBLIC
          ? ToolsetVisibility.PUBLIC
          : ToolsetVisibility.UNLISTED;
      return {
        ...state,
        visibility: ToolsetVisibility.PRIVATE,
        listingStatus: null,
        graceVisibility: widerGrace(state.graceVisibility, kind),
        // Stopping never extends a grace period a delist already started.
        graceUntil: earlier(state.graceUntil, graceEnd),
      };
    }

    case 'ROTATE':
      if (state.removedAt) throw new SharingTransitionError('TAKEN_DOWN');
      if (state.deletedAt) throw new SharingTransitionError('DELETED');
      if (!isShared(state)) throw new SharingTransitionError('NOT_SHARED');
      return { ...state, unlistedToken: token() };

    case 'DELIST':
      if (state.visibility !== ToolsetVisibility.PUBLIC || state.delistedAt !== null) {
        throw new SharingTransitionError('NOT_LISTED');
      }
      return {
        ...state,
        listingStatus: ListingStatus.DELISTED,
        delistedAt: now,
        graceVisibility: ToolsetVisibility.PUBLIC,
        graceUntil: earlier(state.graceUntil, graceEnd),
      };

    case 'RELIST': {
      if (state.delistedAt === null) throw new SharingTransitionError('NOT_DELISTED');
      const isPublic = state.visibility === ToolsetVisibility.PUBLIC;
      return {
        ...state,
        delistedAt: null,
        listingStatus: isPublic ? ListingStatus.LISTED : state.listingStatus,
        // The grace a delist opened ends with it; one the owner opened stays.
        graceVisibility: isPublic ? null : state.graceVisibility,
        graceUntil: isPublic ? null : state.graceUntil,
      };
    }

    case 'TAKEDOWN':
      if (state.removedAt) throw new SharingTransitionError('ALREADY_TAKEN_DOWN');
      return { ...state, removedAt: now };

    case 'RESTORE':
      if (!state.removedAt) throw new SharingTransitionError('NOT_TAKEN_DOWN');
      return { ...state, removedAt: null };

    case 'DELETE': {
      if (state.deletedAt) throw new SharingTransitionError('DELETED');
      const keepServing = action.usedByOthers && (isShared(state) || inGrace(state, now));
      const stopped = keepServing ? applySharing(state, { kind: 'STOP' }, now, token) : state;
      return {
        ...stopped,
        visibility: ToolsetVisibility.PRIVATE,
        listingStatus: null,
        graceVisibility: keepServing ? stopped.graceVisibility : null,
        graceUntil: keepServing ? stopped.graceUntil : null,
        unlistedToken: keepServing ? stopped.unlistedToken : null,
        deletedAt: now,
      };
    }

    case 'EXPIRE_GRACE': {
      if (!state.graceUntil || state.graceUntil.getTime() > now.getTime()) return state;
      return {
        ...state,
        graceVisibility: null,
        graceUntil: null,
        // A link that served only through the grace period is gone for good.
        unlistedToken:
          state.visibility === ToolsetVisibility.PRIVATE || state.deletedAt
            ? null
            : state.unlistedToken,
      };
    }
  }
}

/** Shared right now by its owner's choice (not by a grace period). */
export function isShared(state: Pick<SharingState, 'visibility' | 'deletedAt'>): boolean {
  return state.deletedAt === null && state.visibility !== ToolsetVisibility.PRIVATE;
}

export function inGrace(state: Pick<SharingState, 'graceUntil'>, now: Date): boolean {
  return state.graceUntil !== null && state.graceUntil.getTime() > now.getTime();
}

/** In the catalogue and in public search: PUBLIC, LISTED, not removed, not deleted. */
export function listedInCatalogue(state: SharingState): boolean {
  return (
    state.removedAt === null &&
    state.deletedAt === null &&
    state.visibility === ToolsetVisibility.PUBLIC &&
    state.listingStatus === ListingStatus.LISTED
  );
}

/**
 * Whether `/@{handle}/{slug}[@n]` serves it. Anything else is the same 404 as
 * a missing slug — slugs are guessable, so this keeps the token the only way
 * into an UNLISTED toolset.
 */
export function servesPublicPath(state: SharingState, now: Date): boolean {
  if (state.removedAt) return false;
  if (listedInCatalogue(state)) return true;
  return state.graceVisibility === ToolsetVisibility.PUBLIC && inGrace(state, now);
}

/** Whether `/u/{token}[@n]` serves it (the token itself is matched by the lookup). */
export function servesUnlistedPath(state: SharingState, now: Date): boolean {
  if (state.removedAt || !state.unlistedToken) return false;
  if (isShared(state)) return true;
  return state.graceVisibility !== null && inGrace(state, now);
}

/**
 * When a URL of this kind stops serving, for `_meta["assay/sharingEnds"]`, or
 * `null` while it serves by the owner's choice.
 */
export function sharingEndsAt(state: SharingState, path: 'PUBLIC' | 'UNLISTED'): Date | null {
  const byChoice = path === 'PUBLIC' ? listedInCatalogue(state) : isShared(state);
  return byChoice ? null : state.graceUntil;
}

function earlier(current: Date | null, candidate: Date): Date {
  return current && current.getTime() < candidate.getTime() ? current : candidate;
}

function widerGrace(
  current: SharingState['graceVisibility'],
  next: ToolsetVisibility.UNLISTED | ToolsetVisibility.PUBLIC,
): ToolsetVisibility.UNLISTED | ToolsetVisibility.PUBLIC {
  return current === ToolsetVisibility.PUBLIC ? ToolsetVisibility.PUBLIC : next;
}
