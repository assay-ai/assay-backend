import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `search_tools` paging cursors (design spec §7.4, "Paging").
 *
 * A cursor is the search itself — query, category, detail, limit — plus where
 * the next page starts, signed with a server secret (HMAC-SHA256) and bound to
 * the credential and the canonical URL that issued it:
 *
 * ```text
 * base64url(json payload) "." base64url(hmac(secret, "assay-search-cursor:v1." + payload))
 * ```
 *
 * - **Tamper-proof**: any change to the payload breaks the signature.
 * - **Not replayable across credentials or URLs**: another key, or the same
 *   key on another URL, fails the binding check. Both are hashed into the
 *   payload, so the cursor does not carry the credential id in clear.
 * - **Bounded**: it expires 10 minutes after the first page was served, and
 *   no cursor is issued beyond page 10.
 *
 * Stateless, so it works on every MCP instance that shares the secret. A
 * cursor never grants anything: every page is ranked again within the
 * caller's view ∩ access as it is at that moment.
 */

export const SEARCH_CURSOR_TTL_MS = 10 * 60_000;
export const SEARCH_MAX_PAGES = 10;

export type SearchDetail = 'names' | 'summary' | 'full';

/** What a cursor continues. */
export interface SearchRequest {
  readonly query: string;
  readonly category: string | null;
  readonly detail: SearchDetail;
  readonly limit: number;
}

export interface CursorBinding {
  readonly credentialId: string;
  readonly canonicalUrl: string;
}

/** A verified cursor: the search, the next offset and the page it serves. */
export interface SearchPosition {
  readonly request: SearchRequest;
  readonly offset: number;
  /** 1-based number of the page this cursor serves (the first page is 1). */
  readonly page: number;
  /** When the first page was served; the cursor dies 10 minutes later. */
  readonly startedAt: number;
}

interface Payload {
  readonly v: 1;
  readonly b: string;
  readonly q: string;
  readonly c: string | null;
  readonly d: SearchDetail;
  readonly l: number;
  readonly o: number;
  readonly p: number;
  readonly t: number;
}

const DOMAIN = 'assay-search-cursor:v1.';
const MAX_CURSOR_LENGTH = 4_096;
const DETAILS: readonly SearchDetail[] = ['names', 'summary', 'full'];

export class SearchCursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length < 32)
      throw new Error('the search cursor secret must be at least 32 characters');
  }

  /** The cursor for the page after `position`, or `null` when no further page is allowed. */
  next(binding: CursorBinding, position: SearchPosition, nextOffset: number): string | null {
    if (position.page >= SEARCH_MAX_PAGES) return null;
    const payload: Payload = {
      v: 1,
      b: bindingHash(binding),
      q: position.request.query,
      c: position.request.category,
      d: position.request.detail,
      l: position.request.limit,
      o: nextOffset,
      p: position.page + 1,
      t: position.startedAt,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /** The position a cursor names, or `null` for anything expired, foreign or altered. */
  read(cursor: string, binding: CursorBinding, now: number): SearchPosition | null {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
      return null;
    }
    const dot = cursor.indexOf('.');
    if (dot <= 0 || dot !== cursor.lastIndexOf('.')) return null;
    const body = cursor.slice(0, dot);
    const signature = Buffer.from(cursor.slice(dot + 1), 'base64url');
    const expected = Buffer.from(this.sign(body), 'base64url');
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;

    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    } catch {
      return null;
    }
    if (!isPayload(payload)) return null;
    if (payload.b !== bindingHash(binding)) return null;
    if (now - payload.t > SEARCH_CURSOR_TTL_MS || payload.t > now + 60_000) return null;
    if (payload.p < 2 || payload.p > SEARCH_MAX_PAGES) return null;

    return {
      request: { query: payload.q, category: payload.c, detail: payload.d, limit: payload.l },
      offset: payload.o,
      page: payload.p,
      startedAt: payload.t,
    };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(DOMAIN).update(body).digest('base64url');
  }
}

function bindingHash(binding: CursorBinding): string {
  return createHash('sha256')
    .update(binding.credentialId)
    .update('\n')
    .update(binding.canonicalUrl)
    .digest('base64url')
    .slice(0, 22);
}

function isPayload(value: unknown): value is Payload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.b === 'string' &&
    typeof p.q === 'string' &&
    (p.c === null || typeof p.c === 'string') &&
    DETAILS.includes(p.d as SearchDetail) &&
    Number.isSafeInteger(p.l) &&
    Number.isSafeInteger(p.o) &&
    (p.o as number) >= 0 &&
    Number.isSafeInteger(p.p) &&
    Number.isSafeInteger(p.t)
  );
}
