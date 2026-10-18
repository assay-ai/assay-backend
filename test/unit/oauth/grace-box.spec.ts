import { digestToken } from '@shared/crypto/token-digest';
import { GracePayload, open, seal } from '@modules/oauth/domain/grace-box';
import { mint } from '@modules/oauth/domain/opaque-token';

const parentToken = mint('assay_rt_');
const parentHash = digestToken(parentToken);
const payload: GracePayload = {
  access_token: mint('assay_at_'),
  refresh_token: mint('assay_rt_'),
  expires_in: 3600,
  scope: 'assay:agent offline_access',
};

const flip = (sealed: string, index: number) => {
  const bytes = Buffer.from(sealed, 'base64url');
  const at = index < 0 ? bytes.length + index : index;
  bytes[at] ^= 0x01;
  return bytes.toString('base64url');
};

describe('refresh grace box (§6.3.11)', () => {
  it('round-trips', () => {
    const sealed = seal(parentToken, parentHash, payload);
    expect(open(parentToken, parentHash, sealed)).toEqual(payload);
  });

  it('never contains the payload or the parent token in the clear', () => {
    const sealed = seal(parentToken, parentHash, payload);
    const decoded = Buffer.from(sealed, 'base64url').toString('latin1');
    for (const secret of [payload.access_token, payload.refresh_token, parentToken, 'assay_']) {
      expect(sealed).not.toContain(secret);
      expect(decoded).not.toContain(secret);
    }
  });

  it('uses a fresh nonce each time', () => {
    const a = seal(parentToken, parentHash, payload);
    const b = seal(parentToken, parentHash, payload);
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url').subarray(0, 12)).not.toEqual(
      Buffer.from(b, 'base64url').subarray(0, 12),
    );
  });

  it('the wrong parent token gives null', () => {
    const sealed = seal(parentToken, parentHash, payload);
    expect(open(mint('assay_rt_'), parentHash, sealed)).toBeNull();
    expect(open(parentToken.slice(0, -1), parentHash, sealed)).toBeNull();
    expect(open('', parentHash, sealed)).toBeNull();
  });

  it('the wrong parent hash gives null', () => {
    const sealed = seal(parentToken, parentHash, payload);
    expect(open(parentToken, digestToken('other'), sealed)).toBeNull();
  });

  it('a tampered tag gives null', () => {
    const sealed = seal(parentToken, parentHash, payload);
    expect(open(parentToken, parentHash, flip(sealed, -1))).toBeNull();
  });

  it('a tampered nonce or ciphertext gives null', () => {
    const sealed = seal(parentToken, parentHash, payload);
    expect(open(parentToken, parentHash, flip(sealed, 0))).toBeNull();
    expect(open(parentToken, parentHash, flip(sealed, 20))).toBeNull();
  });

  it('a truncated or malformed box gives null', () => {
    const sealed = seal(parentToken, parentHash, payload);
    for (const box of [
      '',
      'x',
      sealed.slice(0, 20),
      sealed.slice(0, -1),
      `${sealed}A`,
      `${sealed}!`,
      'not base64url at all ***',
    ]) {
      expect(open(parentToken, parentHash, box)).toBeNull();
    }
    expect(open(parentToken, parentHash, undefined as unknown as string)).toBeNull();
  });

  it('refuses a box whose plaintext is not a grace payload', () => {
    // Sealed with a valid key but a wrong shape: opened as null, never half-trusted.
    const odd = seal(parentToken, parentHash, {
      ...payload,
      expires_in: '3600',
    } as unknown as GracePayload);
    expect(open(parentToken, parentHash, odd)).toBeNull();
  });
});
