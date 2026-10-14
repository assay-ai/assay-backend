/**
 * Structural redaction.
 *
 * Never logged: response bodies (they live in retention-controlled storage),
 * private key material, session tokens, full voucher signatures.
 * docs/architecture.md
 * names five env vars by name (`VERIFIER_SIGNING_KEYS`, `JWT_SECRET`,
 * `VERIFICATION_SAMPLING_SECRET`, `REDIS_PASSWORD`, `DATABASE_PASSWORD`), any
 * `Authorization: Bearer …` value, and the raw agent-credential token
 * (`src/database/postgres/entities/agent-credential.entity.ts` — only
 * `prefix` and `tokenHash` are safe).
 *
 * This walks the *object* about to be emitted and blanks values by key name,
 * deliberately not a regex over the rendered line — a regex has to be
 * re-derived every time a new secret-shaped field is added, and it cannot see
 * a secret that got interpolated into a free-text message before it reached
 * the logger. Redacting by key name at the object boundary means a field
 * named like a secret is safe *by construction*, wherever in the call graph
 * it was built.
 */

export const REDACTED = '[REDACTED]';

/**
 * Keys that would otherwise match a forbidden substring but are explicitly
 * safe to log — `agent-credential.entity.ts`'s two exceptions.
 *
 * Checked against the *normalized* key (see {@link normalizeKey}), so this
 * also clears `token_hash` and `TokenHash`, not just the exact spelling.
 */
const SAFE_KEYS = new Set(['tokenhash', 'prefix']);

/**
 * Substrings of a normalized key that mark its value as forbidden, wherever
 * they occur.
 *
 * Deliberately broad rather than an exact list of the five named env vars:
 * `verifiersigningkeys` contains `signingkey`, `jwtsecret` and
 * `verificationsamplingsecret` contain `secret`, `redispassword` and
 * `databasepassword` contain `password` — the five names above are
 * instances of these patterns, not the whole set. A sixth key shaped like a
 * secret is caught without this list growing.
 *
 * `token` and `signature` are deliberately **not** here — see
 * {@link FORBIDDEN_KEY_EXACT}.
 */
const FORBIDDEN_KEY_SUBSTRINGS = [
  'password',
  'secret',
  'privatekey',
  'signingkey',
  'authorization',
  // The retired `X-Operator-Approver` header carried a second operator's
  // bearer token. Nothing reads it any more; an old client may still send one.
  'operatorapprover',
  'apikey',
  'cookie',
] as const;

/**
 * Full normalized key names that are forbidden only as a whole, not as a
 * substring.
 *
 * This codebase's Solana surface names public, safe-to-log fields with
 * `token` and `signature` as qualified suffixes — `funderTokenAccount`,
 * `restorerTokenAccount`, `executionSignature`, `reversalSignature` are
 * addresses and transaction signatures, not secrets, and the Solana
 * operations runbooks depend on being able to log them. A substring
 * rule would blank every one of those. The one thing that actually must never
 * appear is the *bare* field: `token` is the exact key
 * `create-agent-credential.dto.ts` returns the raw agent-credential secret
 * under (`token: string`, "the one and only time the secret is visible"),
 * `signature` is the exact key `voucher.types.ts`'s `Voucher.signature` and
 * `verifier-signing-log-entry.entity.ts`'s attestation signature use — the
 * "full voucher signatures" rule. `accessToken` / `refreshToken` /
 * `sessionToken` / `bearerToken` are the generic session-token shapes the
 * "session tokens" rule covers.
 */
const FORBIDDEN_KEY_EXACT = new Set([
  'token',
  // The Privy access token, under the names it travels as. The bearer
  // value itself is caught by `authorization`, but a verifier that ever put
  // the credential in a structured field would name it one of these. `sub`,
  // `sid` and `kid` are deliberately absent: a DID, a session id and a key id
  // are identifiers, and blanking them would remove the only way to follow one
  // login through a log.
  'jwt',
  'idtoken',
  'bearer',
  'privytoken',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'bearertoken',
  'apitoken',
  'authtoken',
  'signature',
  'body',
  'requestbody',
  'responsebody',
  'rawbody',
]);

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export function isForbiddenKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SAFE_KEYS.has(normalized)) return false;
  if (FORBIDDEN_KEY_EXACT.has(normalized)) return true;
  return FORBIDDEN_KEY_SUBSTRINGS.some((pattern) => normalized.includes(pattern));
}

/** Depth guard against a pathological or accidentally-cyclic payload. */
const MAX_DEPTH = 12;

/**
 * Deep-redacts `value`, returning a new structure — never mutates the input.
 *
 * `seen` guards against a circular reference (a rare but real shape for
 * ORM entities with back-references); `depth` guards against a payload deep
 * enough to be a bug rather than data.
 */
export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date || value instanceof RegExp) {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return '[TRUNCATED]';
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen, depth + 1));
  }

  if (value instanceof Error) {
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const raw = (value as unknown as Record<string, unknown>)[key];
      extra[key] = isForbiddenKey(key) ? REDACTED : redact(raw, seen, depth + 1);
    }
    return { name: value.name, message: value.message, stack: value.stack, ...extra };
  }

  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isForbiddenKey(key) ? REDACTED : redact(entryValue, seen, depth + 1);
  }
  return output;
}
