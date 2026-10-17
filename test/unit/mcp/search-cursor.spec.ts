import {
  SEARCH_CURSOR_TTL_MS,
  SEARCH_MAX_PAGES,
  SearchCursorCodec,
  SearchPosition,
} from '@modules/mcp/domain/search-cursor';

const SECRET = 'a-test-secret-that-is-long-enough-0123456789';
const BINDING = { credentialId: 'cred-1', canonicalUrl: 'https://mcp.example.com/' };
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);

function first(overrides: Partial<SearchPosition> = {}): SearchPosition {
  return {
    request: { query: 'weather', category: null, detail: 'summary', limit: 5 },
    offset: 0,
    page: 1,
    startedAt: T0,
    ...overrides,
  };
}

/** `search_tools` cursors (design spec §7.4, "Paging"). */
describe('SearchCursorCodec', () => {
  const codec = new SearchCursorCodec(SECRET);

  it('round-trips the search, the next offset and the page', () => {
    const cursor = codec.next(BINDING, first(), 5)!;
    expect(codec.read(cursor, BINDING, T0 + 1_000)).toEqual({
      request: { query: 'weather', category: null, detail: 'summary', limit: 5 },
      offset: 5,
      page: 2,
      startedAt: T0,
    });
  });

  it('is refused when altered: payload or signature', () => {
    const cursor = codec.next(BINDING, first(), 5)!;
    const [body, signature] = cursor.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, o: 0, q: 'other' })).toString(
      'base64url',
    );
    expect(codec.read(`${forged}.${signature}`, BINDING, T0)).toBeNull();
    expect(codec.read(`${body}.${signature.slice(0, -2)}AA`, BINDING, T0)).toBeNull();
    expect(codec.read(`${body}`, BINDING, T0)).toBeNull();
    expect(codec.read(`${body}.${signature}.x`, BINDING, T0)).toBeNull();
    expect(codec.read('', BINDING, T0)).toBeNull();
    expect(codec.read('x'.repeat(5_000), BINDING, T0)).toBeNull();
  });

  it('is refused under another secret', () => {
    const cursor = codec.next(BINDING, first(), 5)!;
    const other = new SearchCursorCodec('another-secret-that-is-long-enough-012345');
    expect(other.read(cursor, BINDING, T0)).toBeNull();
  });

  it('cannot be replayed by another credential, or on another URL', () => {
    const cursor = codec.next(BINDING, first(), 5)!;
    expect(codec.read(cursor, { ...BINDING, credentialId: 'cred-2' }, T0)).toBeNull();
    expect(
      codec.read(cursor, { ...BINDING, canonicalUrl: 'https://mcp.example.com/c/weather' }, T0),
    ).toBeNull();
  });

  it('does not carry the credential id in clear', () => {
    const cursor = codec.next(BINDING, first(), 5)!;
    expect(Buffer.from(cursor.split('.')[0], 'base64url').toString()).not.toContain('cred-1');
  });

  it('expires 10 minutes after the first page, whichever page it is', () => {
    const cursor = codec.next(BINDING, first({ page: 3 }), 15)!;
    expect(codec.read(cursor, BINDING, T0 + SEARCH_CURSOR_TTL_MS)).not.toBeNull();
    expect(codec.read(cursor, BINDING, T0 + SEARCH_CURSOR_TTL_MS + 1)).toBeNull();
  });

  it(`stops at ${SEARCH_MAX_PAGES} pages`, () => {
    expect(codec.next(BINDING, first({ page: SEARCH_MAX_PAGES - 1 }), 45)).not.toBeNull();
    expect(codec.next(BINDING, first({ page: SEARCH_MAX_PAGES }), 50)).toBeNull();
  });

  it('refuses a short secret', () => {
    expect(() => new SearchCursorCodec('short')).toThrow(/32/);
  });
});
