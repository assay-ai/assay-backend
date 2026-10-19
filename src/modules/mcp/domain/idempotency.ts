import { createHash } from 'node:crypto';

import { JsonObject } from '@modules/tool/domain/mapping';
import { canonicalJson } from '@shared/crypto/canonical-json';

import { McpErrors } from '../errors/mcp.errors';

/**
 * The idempotency key of an MCP `tools/call` (`_meta["assay/idempotency-key"]`,
 * G2.1) — the pure half: what a valid key is, and what one logical call's
 * identity is made of. `McpIdempotencyStore` owns the Redis record.
 */

/** The longest key accepted. Long enough for any UUID or ULID with a prefix. */
export const MCP_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Printable ASCII, space included (`0x20`–`0x7E`), at least one character. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * The key from the request's `_meta`, or `null` when the agent sent none.
 *
 * Absent and `null` both mean "no key", and the call then behaves exactly as
 * it did before keys existed. Anything else that is not a printable ASCII
 * string of 1 to {@link MCP_IDEMPOTENCY_KEY_MAX_LENGTH} characters is refused
 * with `MCP_IDEMPOTENCY_KEY_INVALID` — before the call runs, so nothing is
 * charged. A malformed key is not treated as absent: the agent asked for
 * retry safety, and silently running without it is the one answer that could
 * charge it twice.
 */
export function parseIdempotencyKey(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw McpErrors.idempotencyKeyInvalid({ reason: 'expected a string' });
  }
  if (raw.length === 0 || raw.length > MCP_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw McpErrors.idempotencyKeyInvalid({
      reason: `expected 1 to ${MCP_IDEMPOTENCY_KEY_MAX_LENGTH} characters, got ${raw.length}`,
    });
  }
  if (!PRINTABLE_ASCII.test(raw)) {
    throw McpErrors.idempotencyKeyInvalid({ reason: 'expected printable ASCII only' });
  }
  return raw;
}

/**
 * The fingerprint of a call's arguments: sha256 over their canonical JSON.
 *
 * Canonical, so a client that re-serialises the same arguments with its keys
 * in another order is still making the same call. Only the hash is stored —
 * the arguments themselves never reach the idempotency record.
 */
export function argumentsFingerprint(args: JsonObject): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');
}

/**
 * The Redis-safe digest of a key. The client's string is hashed rather than
 * embedded, so the record's name has a fixed length and no client-chosen
 * characters.
 */
export function idempotencyKeyDigest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
