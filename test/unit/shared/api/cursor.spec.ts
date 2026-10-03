import { decodeCursor, encodeCursor } from '@shared/api/cursor';
import { ApiErrorCode } from '@shared/api/errors/api.errors';
import { BaseError } from '@shared/errors/base.error';

const SORT = 'createdAt:desc';

/** The code and status a thrown cursor failure carries, or a readable failure. */
function raised(fn: () => unknown): { code: string; statusCode: number } {
  try {
    fn();
  } catch (error) {
    const e = error as BaseError;
    return { code: e.errorCode, statusCode: e.statusCode };
  }
  throw new Error('expected a throw, got none');
}

describe('cursor codec', () => {
  it('round-trips a position unchanged', () => {
    const cursor = encodeCursor({ sortValue: '2026-08-15T10:00:00.000Z', id: 'abc-123' }, SORT);

    expect(decodeCursor(cursor, SORT)).toEqual({
      sortValue: '2026-08-15T10:00:00.000Z',
      id: 'abc-123',
      sort: SORT,
    });
  });

  it('round-trips an exact numeric without going through Number', () => {
    // 78-digit `numeric` is the ledger's column width. Through a float this
    // loses its low digits, and the next page starts in the wrong place.
    const exact = '123456789012345678901234567890';
    const cursor = encodeCursor({ sortValue: exact, id: 'x' }, 'amount:asc');

    expect(decodeCursor(cursor, 'amount:asc').sortValue).toBe(exact);
  });

  it('is opaque — the position is not readable from the cursor', () => {
    const cursor = encodeCursor({ sortValue: '2026-08-15T10:00:00.000Z', id: 'abc' }, SORT);

    expect(cursor).not.toContain('2026-08-15');
    expect(cursor).not.toContain('abc');
  });

  it('is URL-safe, so it survives a query string untouched', () => {
    const cursor = encodeCursor(
      { sortValue: '2026-08-15T10:00:00.000Z', id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
      SORT,
    );

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  describe('rejects anything it did not issue', () => {
    it.each([
      ['not base64 at all', '!!!not-a-cursor!!!'],
      ['base64 of non-JSON', Buffer.from('hello', 'utf8').toString('base64url')],
      ['base64 of a JSON scalar', Buffer.from('42', 'utf8').toString('base64url')],
      ['base64 of null', Buffer.from('null', 'utf8').toString('base64url')],
      ['an empty string payload', Buffer.from('""', 'utf8').toString('base64url')],
      [
        'a payload missing the tiebreak',
        Buffer.from(JSON.stringify({ v: 1, k: 'x', s: SORT }), 'utf8').toString('base64url'),
      ],
      [
        'a payload with a non-string key',
        Buffer.from(JSON.stringify({ v: 1, k: 5, i: 'x', s: SORT }), 'utf8').toString('base64url'),
      ],
      [
        'a future encoding version',
        Buffer.from(JSON.stringify({ v: 99, k: 'x', i: 'y', s: SORT }), 'utf8').toString(
          'base64url',
        ),
      ],
    ])('%s → API_INVALID_CURSOR, 400', (_case, cursor) => {
      expect(raised(() => decodeCursor(cursor, SORT))).toEqual({
        code: ApiErrorCode.API_INVALID_CURSOR,
        statusCode: 400,
      });
    });

    it('a truncated cursor does not decode to a valid position', () => {
      const cursor = encodeCursor({ sortValue: '2026-08-15T10:00:00.000Z', id: 'abc' }, SORT);

      expect(raised(() => decodeCursor(cursor.slice(0, -6), SORT)).code).toBe(
        ApiErrorCode.API_INVALID_CURSOR,
      );
    });
  });

  describe('the sort stamp', () => {
    // The defect this prevents is silent: paging on with a cursor taken under a
    // different ordering returns plausible rows that skip and repeat parts of
    // the collection. A dashboard does this on the second click of a sort header.
    it('rejects a cursor taken under a different direction', () => {
      const cursor = encodeCursor({ sortValue: 'v', id: 'i' }, 'createdAt:desc');

      expect(raised(() => decodeCursor(cursor, 'createdAt:asc')).code).toBe(
        ApiErrorCode.API_INVALID_CURSOR,
      );
    });

    it('rejects a cursor taken under a different field', () => {
      const cursor = encodeCursor({ sortValue: 'v', id: 'i' }, 'createdAt:desc');

      expect(raised(() => decodeCursor(cursor, 'amount:desc')).code).toBe(
        ApiErrorCode.API_INVALID_CURSOR,
      );
    });
  });

  it('never reveals how the cursor was malformed in a machine-readable way', () => {
    // `detail` is folded into the prose so it reaches a log, not a parser. A
    // client that can branch on *why* a cursor failed is a client that will
    // start building them, and then the encoding cannot change.
    let message = '';
    try {
      decodeCursor('!!!', SORT);
    } catch (error) {
      message = (error as BaseError).message;
    }

    expect(message).toContain('opaque');
    expect(Object.keys(JSON.parse(JSON.stringify(new Error(message))))).not.toContain('detail');
  });
});
