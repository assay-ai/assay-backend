import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for a provider's credential header set.
 *
 * ```text
 * KEK (env, 32 bytes) --wraps--> DEK (random per set) --encrypts--> JSON headers
 * ```
 *
 * Both layers are AES-256-GCM with a fresh random 12-byte IV per encryption and
 * the 16-byte auth tag appended to the output. Both layers bind the same AAD
 * (`credentialAad`), so a ciphertext cannot be moved to another organization,
 * binding or origin, even by someone who can write the table. Error messages
 * never carry key material, plaintext or ciphertext.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface CredentialHeader {
  readonly name: string;
  readonly value: string;
}

export interface Kek {
  readonly keyId: string;
  /** 32 bytes. */
  readonly key: Buffer;
}

export interface SealedCredentialSet {
  kekId: string;
  /** DEK encrypted under the KEK, auth tag appended. */
  wrappedDek: Buffer;
  dekIv: Buffer;
  /** Header JSON encrypted under the DEK, auth tag appended. */
  ciphertext: Buffer;
  iv: Buffer;
}

const KCV_LABEL = 'assay/kek-check/v1';
const KCV_BYTES = 16;

/**
 * The key-check value of a KEK: HMAC-SHA256 of a fixed label, truncated to 16
 * bytes. Stored per key id so a boot can tell that an id now holds different
 * bytes, without the value helping anyone recover the key.
 */
export function kekCheckValue(kek: Kek): Buffer {
  return createHmac('sha256', kek.key).update(KCV_LABEL).digest().subarray(0, KCV_BYTES);
}

export function credentialAad(organizationId: string, bindingId: string, origin: string): string {
  return `assay/binding-credentials/v1/${organizationId}/${bindingId}/${origin}`;
}

/** Last 4 characters, only for values long enough that 4 characters reveal little. */
export function valueHint(value: string): string | null {
  return value.length >= 16 ? value.slice(-4) : null;
}

function encrypt(key: Buffer, plaintext: Buffer, aad: string): { iv: Buffer; output: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, output: Buffer.concat([body, cipher.getAuthTag()]) };
}

function decrypt(key: Buffer, iv: Buffer, sealed: Buffer, aad: string): Buffer {
  if (iv.length !== IV_BYTES || sealed.length < TAG_BYTES) {
    throw new Error('credential vault: malformed ciphertext');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    // Node's message is generic, but never forward anything from the cipher.
    throw new Error('credential vault: authentication failed');
  }
}

export function sealCredentialSet(
  headers: readonly CredentialHeader[],
  kek: Kek,
  aad: string,
): SealedCredentialSet {
  if (kek.key.length !== KEY_BYTES) {
    throw new Error('credential vault: KEK must be 32 bytes');
  }
  const dek = randomBytes(KEY_BYTES);
  try {
    const plaintext = Buffer.from(
      JSON.stringify(headers.map((h) => ({ name: h.name, value: h.value }))),
      'utf8',
    );
    const data = encrypt(dek, plaintext, aad);
    const wrapped = encrypt(kek.key, dek, aad);
    plaintext.fill(0);
    return {
      kekId: kek.keyId,
      wrappedDek: wrapped.output,
      dekIv: wrapped.iv,
      ciphertext: data.output,
      iv: data.iv,
    };
  } finally {
    dek.fill(0);
  }
}

export function openCredentialSet(
  sealed: SealedCredentialSet,
  keks: ReadonlyMap<string, Kek>,
  aad: string,
): CredentialHeader[] {
  const kek = keks.get(sealed.kekId);
  if (!kek) {
    throw new Error('credential vault: unknown KEK id');
  }
  const dek = decrypt(kek.key, sealed.dekIv, sealed.wrappedDek, aad);
  try {
    const plaintext = decrypt(dek, sealed.iv, sealed.ciphertext, aad);
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    plaintext.fill(0);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((h) => h && typeof h.name === 'string' && typeof h.value === 'string')
    ) {
      throw new Error('credential vault: malformed plaintext');
    }
    return parsed.map((h) => ({ name: h.name, value: h.value }));
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-wraps a set's DEK under another KEK. `ciphertext` and `iv` are untouched,
 * so the plaintext headers are never opened. The AAD is the same one the set
 * was sealed with.
 */
export function rewrapDek(
  sealed: Pick<SealedCredentialSet, 'kekId' | 'wrappedDek' | 'dekIv'>,
  from: Kek,
  to: Kek,
  aad: string,
): Pick<SealedCredentialSet, 'kekId' | 'wrappedDek' | 'dekIv'> {
  if (to.key.length !== KEY_BYTES) {
    throw new Error('credential vault: KEK must be 32 bytes');
  }
  const dek = decrypt(from.key, sealed.dekIv, sealed.wrappedDek, aad);
  try {
    const wrapped = encrypt(to.key, dek, aad);
    return { kekId: to.keyId, wrappedDek: wrapped.output, dekIv: wrapped.iv };
  } finally {
    dek.fill(0);
  }
}
