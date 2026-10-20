import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SLASH_DELAY_SECONDS, WITHDRAW_DELAY_SECONDS } from '@assay/settlement-client';

/**
 * The two `#[constant]` delays, checked against the IDL they claim to come
 * from.
 *
 * Codama renders instructions, accounts, PDAs, types and errors; it does **not**
 * render the IDL's `constants` array. So `packages/settlement-client/src/program-constants.ts`
 * is a hand-written copy of part of the program's interface — the same category
 * of thing `record-pdas.ts` and `attestation-message.ts` are — and it gets the
 * same treatment: a test that reads the IDL and compares, so a re-vendor that
 * moves a number turns this red rather than turning a countdown wrong.
 *
 * These two were fields of `Config` before the contract simplification, and that is exactly why the
 * check matters. A value read live off a mutable account cannot drift from the
 * program silently; a value retyped in TypeScript can.
 */
const IDL = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../packages/settlement-client/idl/assay_payment.json'),
    'utf8',
  ),
) as { constants: { name: string; type: string; value: string }[] };

function idlConstant(name: string): number {
  const entry = IDL.constants.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`${name} is not a #[constant] the program declares`);
  }
  return Number(entry.value);
}

describe('the program constants the backend retypes', () => {
  it('carries SLASH_DELAY_SECONDS exactly as the IDL declares it', () => {
    expect(SLASH_DELAY_SECONDS).toBe(idlConstant('SLASH_DELAY_SECONDS'));
    // 72 hours. Stated as well as compared, because the comparison alone would
    // pass just as happily on a program that had quietly dropped it to an hour.
    expect(SLASH_DELAY_SECONDS).toBe(72 * 3600);
  });

  it('carries WITHDRAW_DELAY_SECONDS exactly as the IDL declares it', () => {
    expect(WITHDRAW_DELAY_SECONDS).toBe(idlConstant('WITHDRAW_DELAY_SECONDS'));
    expect(WITHDRAW_DELAY_SECONDS).toBe(3600);
  });

  it('keeps the buyer withdrawal delay longer than a voucher can live', () => {
    // The property that replaced the exposure authority. `WITHDRAW_DELAY_SECONDS`
    // exceeding the maximum life of a redeemable voucher is what stops a buyer
    // withdrawing out from under a voucher already signed and in flight — which
    // used to need an on-chain assertion of unsettled exposure.
    //
    // The voucher's own window is `VOUCHER_MAX_LIFETIME_SECONDS + REDEEM_GRACE_SECONDS`
    // in `constants.rs`; both are program constants and neither is in the IDL,
    // so this compares against the backend's own figure for the same window.
    const maxVoucherLife = 5 * 60 + 30 * 60;
    expect(WITHDRAW_DELAY_SECONDS).toBeGreaterThan(maxVoucherLife);
  });
});
