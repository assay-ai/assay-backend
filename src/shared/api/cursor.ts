import { ApiErrors } from './errors/api.errors';

/**
 * The position of one row in one ordering.
 *
 * Two fields, because one is not enough. `sortValue` alone cannot resolve ties,
 * and ties are the normal case here rather than the exotic one: a burst of tool
 * calls written in the same millisecond share a `created_at` exactly. A keyset
 * predicate on a non-unique column silently drops every row it cannot order
 * against, so the tiebreak `id` is part of the position, not a detail of it.
 */
export interface CursorPosition {
  /**
   * The sort column's value on the last row of the previous page, serialised.
   *
   * A string rather than a `Date | string | number` union, because this
   * survives a round trip through base64 and back — and `new Date(x)` on
   * something that was a bigint, or `Number(x)` on something that was an ISO
   * timestamp, is exactly the class of bug an opaque cursor is supposed to make
   * unrepresentable. The caller that encoded it knows the type; the codec does
   * not need to.
   */
  readonly sortValue: string;
  /** Primary key of that row — the tiebreak. */
  readonly id: string;
}

/**
 * What a decoded cursor asserts, beyond the position: the ordering it was taken
 * under.
 */
export interface DecodedCursor extends CursorPosition {
  /** `<field>:<asc|desc>`, matched against the request's ordering. */
  readonly sort: string;
}

/** Bumped if the payload shape changes; an old cursor then fails closed. */
const CURSOR_VERSION = 1;

interface CursorPayload {
  readonly v: number;
  readonly k: string;
  readonly i: string;
  readonly s: string;
}

/**
 * Encodes a position into the opaque string a client passes back.
 *
 * base64url of compact JSON. **Not signed**, and that is a considered choice
 * rather than an omission. A signature would defend against a caller forging a
 * cursor, but a forged cursor buys nothing: the query it is spliced into is
 * already constrained to the caller's own `organizationId` by
 * `SessionAuthGuard` and `OrganizationScopedRepository`, independently of
 * anything in the cursor, and the position lands as a **bound parameter** so it
 * cannot alter the statement. The worst a forger achieves is a differently
 * positioned page of their own data. Signing would add a secret to rotate, a
 * boot-time dependency, and a class of "all cursors expired" incident, to
 * defend a boundary that is held somewhere else.
 *
 * Opacity is still worth having, which is why it is encoded at all — a client
 * that can read `{"k":"2026-08-01..."}` will start constructing cursors by
 * hand, and then the encoding cannot change.
 */
export function encodeCursor(position: CursorPosition, sort: string): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    k: position.sortValue,
    i: position.id,
    s: sort,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or raises `API_INVALID_CURSOR`.
 *
 * `expectedSort` is checked rather than trusted, and this is the check that
 * earns the `sort` field its place in the payload. Paging with a cursor taken
 * under one ordering while asking for another does not fail loudly — it
 * produces a page of *plausible* rows that silently skips and repeats parts of
 * the collection, because the keyset predicate is comparing against a bound
 * from a different sequence. A dashboard that lets the user flip sort order
 * mid-list will do this on its second click. Rejecting it here turns a wrong
 * answer into a 400 the client can act on.
 *
 * Everything is validated: version, presence, and type of each field. A cursor
 * from a previous encoding, a truncated one, and a hand-written one all land in
 * the same place, which is the point.
 */
export function decodeCursor(cursor: string, expectedSort: string): DecodedCursor {
  let payload: unknown;

  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw ApiErrors.invalidCursor({ detail: 'not decodable' });
  }

  if (typeof payload !== 'object' || payload === null) {
    throw ApiErrors.invalidCursor({ detail: 'not an object' });
  }

  const { v, k, i, s } = payload as Partial<CursorPayload>;

  if (v !== CURSOR_VERSION) {
    throw ApiErrors.invalidCursor({ detail: `unsupported version ${String(v)}` });
  }
  if (typeof k !== 'string' || typeof i !== 'string' || typeof s !== 'string') {
    throw ApiErrors.invalidCursor({ detail: 'malformed payload' });
  }
  if (s !== expectedSort) {
    throw ApiErrors.invalidCursor({
      detail: `taken under sort "${s}" but this request sorts by "${expectedSort}"`,
    });
  }

  return { sortValue: k, id: i, sort: s };
}
