import { AllowedToolsetRef, PinPath, linkHashOf } from './access';
import { SharedPathKind, SharingState, servesPublicPath, servesUnlistedPath } from './sharing';

/**
 * How another organization's pin reaches its toolset **now**, or `null`
 * (design spec §7.7; review N1, N4). A pin taken through `/@…` reaches it
 * while `/@…` serves; one taken through the link reaches it only while that
 * same link serves — a rotated token is a different link. A pin with no path
 * (an Official set, or one written before pins recorded it) reaches it only
 * through `/@…`.
 *
 * This decides update notices and the "Update available" chip. It never
 * narrows what the pinned version allows: that snapshot is immutable.
 */
export function pinReaches(
  ref: Pick<AllowedToolsetRef, 'via' | 'linkHash'>,
  state: SharingState,
  now: Date,
): SharedPathKind | null {
  if (ref.via === 'LINK') {
    return state.unlistedToken !== null &&
      ref.linkHash === linkHashOf(state.unlistedToken) &&
      servesUnlistedPath(state, now)
      ? 'UNLISTED'
      : null;
  }
  return servesPublicPath(state, now) ? 'PUBLIC' : null;
}

/** The path a pin records for a toolset reached by `path` with `token`. */
export function pinPathOf(
  path: SharedPathKind,
  token: string | undefined,
): { via: PinPath; linkHash: string | null } {
  return path === 'UNLISTED' && token
    ? { via: 'LINK', linkHash: linkHashOf(token) }
    : { via: 'PUBLIC', linkHash: null };
}
