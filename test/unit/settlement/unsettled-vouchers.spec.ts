import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import {
  loweredCaps,
  NO_UNSETTLED_VOUCHERS,
  StrandReason,
  strandedBy,
  UnsettledVouchers,
} from '@modules/settlement/domain/unsettled-vouchers';
import {
  TIGHTENING_ADMISSION_HOLD_MS,
  TIGHTENING_ADMISSION_SETTLE_MS,
} from '@modules/settlement/services/unsettled-voucher-guard.service';

import { guardOver } from './helpers/unsettled-guard';

const PAYER = 'eip155:46630:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296' as AccountId;
const DELEGATE = 'eip155:46630:0x76B98f0000000000000000000000000000d10C' as AccountId;
const USDG = 'eip155:46630/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac' as AssetId;

/**
 * BUG-D1-07, the D1 retest: the delegate's window W = 5, its chain counter
 * about 2.27, one paid call (0.10) served and not yet redeemed. Lowering W to
 * 2 made that voucher need `counter + 0.10 <= 2.0`, which could not hold for
 * hours; it would have expired and the platform would have paid the provider.
 */
const RETEST: UnsettledVouchers = {
  count: 1,
  total: 100_000n,
  largest: 100_000n,
  windowNeeds: 2_270_000n + 100_000n,
  redeemableUntil: new Date('2026-10-12T15:27:11Z'),
};

describe('strandedBy (BUG-D1-07)', () => {
  it('names the window when the lowered cap is below counter + unsettled', () => {
    expect(strandedBy(RETEST, { maxPerWindow: 2_000_000n })).toEqual([StrandReason.MAX_PER_WINDOW]);
  });

  it('passes a lowered window that still holds them', () => {
    expect(strandedBy(RETEST, { maxPerWindow: 2_370_000n })).toEqual([]);
  });

  it('names the per-voucher cap when one unsettled voucher is larger', () => {
    expect(strandedBy(RETEST, { maxVoucherAmount: 99_999n })).toEqual([
      StrandReason.MAX_VOUCHER_AMOUNT,
    ]);
    expect(strandedBy(RETEST, { maxVoucherAmount: 100_000n })).toEqual([]);
  });

  it('names an expiry before the chain could still redeem them, and a revocation', () => {
    const before = BigInt(Math.floor(RETEST.redeemableUntil!.getTime() / 1000) - 1);
    expect(strandedBy(RETEST, { validUntil: before })).toEqual([StrandReason.VALID_UNTIL]);
    expect(strandedBy(RETEST, { revoked: true })).toEqual([StrandReason.REVOKED]);
  });

  it('strands nothing when nothing is unsettled, however low the caps', () => {
    expect(
      strandedBy(NO_UNSETTLED_VOUCHERS, {
        maxVoucherAmount: 1n,
        maxPerWindow: 1n,
        validUntil: 1n,
        revoked: true,
      }),
    ).toEqual([]);
  });
});

describe('loweredCaps', () => {
  const current = { maxVoucherAmount: 500_000n, maxPerWindow: 5_000_000n, validUntil: 2_000n };

  it('keeps only the caps that go down', () => {
    expect(
      loweredCaps(current, {
        maxVoucherAmount: 600_000n,
        maxPerWindow: 2_000_000n,
        validUntil: 3_000n,
      }),
    ).toEqual({ maxPerWindow: 2_000_000n });
    expect(loweredCaps(current, { ...current, validUntil: 1_000n })).toEqual({
      validUntil: 1_000n,
    });
  });

  it('lowers nothing for a key with no standing grant', () => {
    expect(loweredCaps(null, { maxVoucherAmount: 1n, maxPerWindow: 1n, validUntil: 1n })).toEqual(
      {},
    );
  });
});

describe('UnsettledVoucherGuard', () => {
  const totals = {
    count: 1,
    total: 100_000n,
    largest: 100_000n,
    redeemableUntil: RETEST.redeemableUntil,
    redeemedSince: 0n,
  };
  const scope = {
    payer: PAYER,
    asset: USDG,
    delegate: DELEGATE,
    carried: 2_270_000n,
    readAt: new Date(),
  };

  it('refuses a stranding change by name, with the count and the amount, unless acknowledged', async () => {
    const { guard } = guardOver(totals);
    const unsettled = await guard.read(scope);
    expect(unsettled.windowNeeds).toBe(2_370_000n);

    expect(() =>
      guard.assertNotStranding(unsettled, { maxPerWindow: 2_000_000n }, USDG, false),
    ).toThrow(
      expect.objectContaining({
        errorCode: 'SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK',
        statusCode: 409,
        message: expect.stringContaining('1 payment is still being settled (0.100000 USDG)'),
      }),
    );
    expect(() =>
      guard.assertNotStranding(unsettled, { maxPerWindow: 2_000_000n }, USDG, true),
    ).not.toThrow();
  });

  it('relays a stranding change only when acknowledged, and pauses admission around it', async () => {
    const { guard, repository } = guardOver(totals);
    const relay = jest.fn(async () => 'landed');

    await expect(
      guard.relayTightening({
        scope,
        lowered: { maxPerWindow: 2_000_000n },
        acknowledged: false,
        relay,
      }),
    ).rejects.toMatchObject({ errorCode: 'SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK' });
    expect(relay).not.toHaveBeenCalled();
    // The pause was taken for the check and lifted at once: nothing landed.
    expect(repository.holdVoucherAdmission).toHaveBeenCalledTimes(1);
    const [, liftedAt] = repository.resumeVoucherAdmission.mock.calls[0] as unknown as [
      string,
      Date,
    ];
    expect(liftedAt.getTime()).toBeLessThanOrEqual(Date.now());

    const before = Date.now();
    await expect(
      guard.relayTightening({
        scope,
        lowered: { maxPerWindow: 2_000_000n },
        acknowledged: true,
        relay,
      }),
    ).resolves.toBe('landed');
    const [payer, until] = repository.holdVoucherAdmission.mock.calls[1] as unknown as [
      string,
      Date,
    ];
    expect(payer).toBe(PAYER);
    expect(until.getTime()).toBeGreaterThanOrEqual(before + TIGHTENING_ADMISSION_HOLD_MS);
    // After landing the pause runs a little longer, for reads taken before it.
    const [, resumeAt] = repository.resumeVoucherAdmission.mock.calls[1] as unknown as [
      string,
      Date,
    ];
    expect(resumeAt.getTime()).toBeGreaterThanOrEqual(before + TIGHTENING_ADMISSION_SETTLE_MS);
  });

  it('leaves the pause to run out when the relay ended without a definite answer', async () => {
    const { guard, repository } = guardOver(totals);
    await expect(
      guard.relayTightening({
        scope,
        lowered: { revoked: true },
        acknowledged: true,
        relay: async () => {
          throw new Error('receipt timeout');
        },
      }),
    ).rejects.toThrow('receipt timeout');
    expect(repository.resumeVoucherAdmission).not.toHaveBeenCalled();
  });

  it('lifts the pause at once when the relay refused by name', async () => {
    const { guard, repository } = guardOver(totals);
    const refused = Object.assign(new Error('BadNonce'), {
      errorCode: 'SETTLEMENT_RELAYED_INTENT_REFUSED',
    });
    await expect(
      guard.relayTightening({
        scope,
        lowered: { revoked: true },
        acknowledged: true,
        relay: async () => {
          throw refused;
        },
      }),
    ).rejects.toBe(refused);
    expect(repository.resumeVoucherAdmission).toHaveBeenCalledTimes(1);
  });

  it('relays a change that lowers nothing without pausing anyone', async () => {
    const { guard, repository } = guardOver(totals);
    await expect(
      guard.relayTightening({ scope, lowered: {}, acknowledged: false, relay: async () => 'ok' }),
    ).resolves.toBe('ok');
    expect(repository.holdVoucherAdmission).not.toHaveBeenCalled();
  });
});
