import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * The refresh grace box (spec §6.3.11).
 *
 * When a refresh token rotates, the new pair is kept for 30 s under
 * `oauth:rt-grace:{parentHash}`, sealed so that only the holder of the parent
 * refresh token can open it: Redis holds no usable token.
 *
 * ```text
 * key    = HKDF-SHA256(ikm = parent token, salt = parent hash, info = "assay oauth refresh grace v1"), 32 bytes
 * box    = base64url(nonce[12] ‖ AES-256-GCM(key, nonce, JSON(payload)) ‖ tag[16])
 * ```
 *
 * {@link open} returns `null` on any failure (wrong token, wrong hash,
 * tampering, truncation, a payload of the wrong shape) and never throws.
 */
export interface GracePayload {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

const INFO = 'assay oauth refresh grace v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function deriveKey(parentToken: string, parentHash: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(parentToken, 'utf8'), Buffer.from(parentHash, 'utf8'), INFO, 32),
  );
}

export function seal(parentToken: string, parentHash: string, payload: GracePayload): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(parentToken, parentHash), nonce, {
    authTagLength: TAG_BYTES,
  });
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
}

export function open(parentToken: string, parentHash: string, sealed: string): GracePayload | null {
  if (
    typeof parentToken !== 'string' ||
    parentToken === '' ||
    typeof parentHash !== 'string' ||
    typeof sealed !== 'string' ||
    !BASE64URL_RE.test(sealed)
  ) {
    return null;
  }
  const bytes = Buffer.from(sealed, 'base64url');
  // Reject non-canonical encodings so one box has exactly one spelling.
  if (bytes.toString('base64url') !== sealed || bytes.length <= NONCE_BYTES + TAG_BYTES) {
    return null;
  }
  try {
    const nonce = bytes.subarray(0, NONCE_BYTES);
    const tag = bytes.subarray(bytes.length - TAG_BYTES);
    const body = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(parentToken, parentHash), nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return asPayload(JSON.parse(plain));
  } catch {
    return null;
  }
}

function asPayload(value: unknown): GracePayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.access_token !== 'string' ||
    typeof v.refresh_token !== 'string' ||
    typeof v.expires_in !== 'number' ||
    !Number.isFinite(v.expires_in) ||
    typeof v.scope !== 'string'
  ) {
    return null;
  }
  return {
    access_token: v.access_token,
    refresh_token: v.refresh_token,
    expires_in: v.expires_in,
    scope: v.scope,
  };
}
