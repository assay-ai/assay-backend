/**
 * The 240 bytes a buyer signs, pinned offset by offset.
 *
 * ## Where these offsets come from
 *
 * The program's `Voucher` struct is `seq, issued_at, expires_at`, which puts
 * `issued_at` at **224** and `expires_at` at **232**. An earlier layout table had
 * the two **swapped**. Copying it would mean every buyer signed a message the
 * program never recomputes: `redeem_voucher` would refuse with
 * `MissingBuyerSignature` after the call had been served and the money held.
 * This file follows the program.
 */
import { address, getAddressEncoder } from '@solana/kit';
import {
  SLASH_MESSAGE_LENGTH,
  VOUCHER_DOMAIN,
  VOUCHER_MESSAGE_LENGTH,
  voucherMessage,
} from '@assay/settlement-client';

const PROGRAM = address('DbHEzzA6CwKRY9xLGSzDgqei7VmnHpF6YociozaN8qFR');
const PAYER = address('9xGuGHFYb4KysmNbZpvHEUJYwxC8zwFhP1GT2apAyCjj');
const PAY_TO = address('AmZv6ZumyEsHtD29eZ6gzNHB7X7ai3eyuy5pRXqo19Df');
const PROVIDER = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

function fields(overrides: Partial<Parameters<typeof voucherMessage>[0]> = {}) {
  return {
    payer: PAYER,
    payTo: PAY_TO,
    provider: PROVIDER,
    amount: 1_000_000n,
    resourceHash: new Uint8Array(32).fill(0xa1),
    requestHash: new Uint8Array(32).fill(0xb2),
    seq: 42n,
    issuedAt: 1_700_000_000n,
    expiresAt: 1_700_000_300n,
    programAddress: PROGRAM,
    ...overrides,
  };
}

const bytes = (value: string) => Uint8Array.from(getAddressEncoder().encode(address(value)));

describe('voucherMessage — the 240 bytes a buyer signs', () => {
  it('is exactly 240 bytes and starts with the v2 domain tag', () => {
    const message = voucherMessage(fields());

    expect(message).toHaveLength(VOUCHER_MESSAGE_LENGTH);
    expect(VOUCHER_MESSAGE_LENGTH).toBe(240);
    expect(Array.from(message.subarray(0, 16))).toEqual(Array.from(VOUCHER_DOMAIN));
    expect(new TextDecoder().decode(message.subarray(0, 16))).toBe('assay:voucher:v2');
  });

  it('puts every field at the offset the program reads it from', () => {
    const message = voucherMessage(fields());

    expect(Array.from(message.subarray(16, 48))).toEqual(Array.from(bytes(PROGRAM)));
    expect(Array.from(message.subarray(48, 80))).toEqual(Array.from(bytes(PAYER)));
    expect(Array.from(message.subarray(80, 112))).toEqual(Array.from(bytes(PAY_TO)));
    expect(Array.from(message.subarray(112, 144))).toEqual(Array.from(bytes(PROVIDER)));
    expect(new DataView(message.buffer).getBigUint64(144, true)).toBe(1_000_000n);
    expect(Array.from(message.subarray(152, 184))).toEqual(Array(32).fill(0xa1));
    expect(Array.from(message.subarray(184, 216))).toEqual(Array(32).fill(0xb2));
    expect(new DataView(message.buffer).getBigUint64(216, true)).toBe(42n);
    // 224 is `issued_at` and 232 is `expires_at`, matching the program's
    // `Voucher` struct; see the file header.
    expect(new DataView(message.buffer).getBigInt64(224, true)).toBe(1_700_000_000n);
    expect(new DataView(message.buffer).getBigInt64(232, true)).toBe(1_700_000_300n);
  });

  it('changes when any one field changes — a signature covers all nine', () => {
    const baseline = voucherMessage(fields());
    const mutations = [
      fields({ payer: PROVIDER }),
      fields({ payTo: PROVIDER }),
      fields({ provider: PAYER }),
      fields({ amount: 1_000_001n }),
      fields({ resourceHash: new Uint8Array(32).fill(0xa2) }),
      fields({ requestHash: new Uint8Array(32).fill(0xb3) }),
      fields({ seq: 43n }),
      fields({ issuedAt: 1_700_000_001n }),
      fields({ expiresAt: 1_700_000_301n }),
      fields({ programAddress: PROVIDER }),
    ];

    for (const mutated of mutations) {
      expect(Array.from(voucherMessage(mutated))).not.toEqual(Array.from(baseline));
    }
  });

  it('does not confuse issued_at with expires_at', () => {
    // Swapping the two produces different bytes, so a program that reads 224 as
    // `issued_at` and a client that writes `expires_at` there cannot both be
    // right. This is the assertion the swapped layout would have failed.
    const straight = voucherMessage(fields());
    const swapped = voucherMessage(fields({ issuedAt: 1_700_000_300n, expiresAt: 1_700_000_000n }));

    expect(Array.from(swapped)).not.toEqual(Array.from(straight));
    expect(new DataView(swapped.buffer).getBigInt64(224, true)).toBe(1_700_000_300n);
    expect(new DataView(swapped.buffer).getBigInt64(232, true)).toBe(1_700_000_000n);
  });

  it('refuses a hash that is not exactly 32 bytes', () => {
    expect(() => voucherMessage(fields({ resourceHash: new Uint8Array(31) }))).toThrow(
      'expected exactly 32 bytes, got 31',
    );
    expect(() => voucherMessage(fields({ requestHash: new Uint8Array(33) }))).toThrow(
      'expected exactly 32 bytes, got 33',
    );
  });

  it('keeps the two signed-message lengths distinct', () => {
    // The program's `data.len()` check rejects a cross-kind message before any
    // field comparison, and `attestation.rs` asserts the inequality at compile
    // time. A collision here would make a voucher presentable at a door it was
    // never signed for. Lean v3 leaves exactly two signed messages: the buyer's
    // voucher and the verifier's slash attestation.
    const lengths = [VOUCHER_MESSAGE_LENGTH, SLASH_MESSAGE_LENGTH];
    expect(new Set(lengths).size).toBe(lengths.length);
    expect(lengths).toEqual([240, 211]);
  });
});
