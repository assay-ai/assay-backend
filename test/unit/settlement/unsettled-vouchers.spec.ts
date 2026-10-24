import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import {
  loweredCaps,
  NO_UNSETTLED_VOUCHERS,
  StrandReason,
  strandedBy,
  UnsettledVouchers,
} from '@modules/settlement/domain/unsettled-vouchers';
import { VOUCHER_ADMISSION_CHAIN_LAG_MS } from '@modules/payment/constants/voucher.constants';
import {
  tighteningHoldMs,
  TIGHTENING_ADMISSION_SETTLE_MS,
  UnsettledVoucherGuard,
} from '@modules/settlement/services/unsettled-voucher-guard.service';
import {
  DEFAULT_EVM_RELAYER_TIMING,
  relayedSendBudgetMs,
} from '@modules/chains/evm/evm-relayer-timing';

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

  /** The signed request's deadline: chain now + 300 s, as the intent builder sets it. */
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 300);
  const holdOf = (repository: ReturnType<typeof guardOver>['repository'], call = 0) =>
    (
      repository.holdVoucherAdmission.mock.calls[call] as unknown as [
        {
          payer: string;
          delegate: string | null;
          holdSeconds: number;
          notBeforeEpochSeconds: number;
        },
      ]
    )[0];

  it('relays a stranding change only when acknowledged, and pauses admission around it', async () => {
    const { guard, repository } = guardOver(totals);
    const relay = jest.fn(async () => 'landed');

    await expect(
      guard.relayTightening({
        scope,
        lowered: { maxPerWindow: 2_000_000n },
        acknowledged: false,
        deadline: deadline(),
        relay,
      }),
    ).rejects.toMatchObject({ errorCode: 'SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK' });
    expect(relay).not.toHaveBeenCalled();
    // The pause was taken for the check and released at once: nothing landed.
    expect(repository.holdVoucherAdmission).toHaveBeenCalledTimes(1);
    expect(repository.releaseVoucherAdmissionPause).toHaveBeenCalledWith('pause-1');

    await expect(
      guard.relayTightening({
        scope,
        lowered: { maxPerWindow: 2_000_000n },
        acknowledged: true,
        deadline: deadline(),
        relay,
      }),
    ).resolves.toBe('landed');
    expect(holdOf(repository, 1).payer).toBe(PAYER);
    // After landing the pause runs on for the chain-lag margin, on the DB clock.
    expect(repository.landVoucherAdmissionPause).toHaveBeenCalledWith(
      'pause-2',
      TIGHTENING_ADMISSION_SETTLE_MS / 1000,
    );
  });

  /**
   * REGRESSION (review finding 1): a second request of the same payer, refused
   * by name, used to end the FIRST one's pause while it was still in flight.
   * Each request now ends only its own pause.
   */
  it('a refused second tightening ends only its own pause, never the one still in flight', async () => {
    const { guard, repository } = guardOver(totals);
    let land!: () => void;
    const first = guard.relayTightening({
      scope,
      lowered: { maxPerWindow: 2_000_000n },
      acknowledged: true,
      deadline: deadline(),
      relay: () => new Promise<string>((resolve) => (land = () => resolve('landed'))),
    });
    await new Promise((resolve) => setImmediate(resolve));

    await expect(
      guard.relayTightening({
        scope,
        lowered: { maxPerWindow: 1_000_000n },
        acknowledged: true,
        deadline: deadline(),
        relay: async () => {
          throw Object.assign(new Error('rate limited'), {
            errorCode: 'SETTLEMENT_RELAYED_INTENT_RATE_LIMITED',
          });
        },
      }),
    ).rejects.toThrow('rate limited');
    expect(repository.releaseVoucherAdmissionPause.mock.calls).toEqual([['pause-2']]);
    expect(repository.landVoucherAdmissionPause).not.toHaveBeenCalled();

    land();
    await first;
    expect(repository.landVoucherAdmissionPause.mock.calls).toEqual([
      ['pause-1', TIGHTENING_ADMISSION_SETTLE_MS / 1000],
    ]);
    expect(repository.releaseVoucherAdmissionPause).toHaveBeenCalledTimes(1);
  });

  /**
   * REGRESSION (review finding 2): the pause was a fixed 120 s, shorter than
   * the relayer's own receipt timeout (180 s) plus its queue. It now lasts at
   * least the relayer's whole send budget from config, and never ends before
   * the signed request's deadline.
   */
  it('holds the pause for the relayer’s whole send budget from config, and until the deadline', async () => {
    const { guard, repository } = guardOver(totals, {
      EVM_RELAYER_RECEIPT_TIMEOUT_MS: '200000',
      EVM_RELAYER_MAX_QUEUE_WAIT_MS: '90000',
    });
    const signedDeadline = deadline();
    await guard.relayTightening({
      scope,
      lowered: { maxPerWindow: 2_000_000n },
      acknowledged: true,
      deadline: signedDeadline,
      relay: async () => 'landed',
    });
    const hold = holdOf(repository);
    expect(hold.holdSeconds * 1000).toBeGreaterThanOrEqual(200_000 + 90_000);
    expect(hold.holdSeconds * 1000).toBe(
      tighteningHoldMs({ receiptTimeoutMs: 200_000, maxQueueWaitMs: 90_000 }),
    );
    expect(hold.notBeforeEpochSeconds).toBe(
      Number(signedDeadline) + VOUCHER_ADMISSION_CHAIN_LAG_MS / 1000,
    );
    // With no config, viem's 180 s receipt timeout plus the default queue bound.
    expect(tighteningHoldMs(DEFAULT_EVM_RELAYER_TIMING)).toBeGreaterThan(
      relayedSendBudgetMs(DEFAULT_EVM_RELAYER_TIMING),
    );
    expect(relayedSendBudgetMs(DEFAULT_EVM_RELAYER_TIMING)).toBeGreaterThanOrEqual(180_000);
  });

  /** REGRESSION (review finding 3): 15 s after landing was shorter than the 30 s chain lag. */
  it('keeps admission paused for at least the admission’s chain-lag margin after landing', () => {
    expect(TIGHTENING_ADMISSION_SETTLE_MS).toBeGreaterThanOrEqual(VOUCHER_ADMISSION_CHAIN_LAG_MS);
  });

  /** Review finding 6: a delegate's change pauses that delegate only; the escrow's, the payer. */
  it('pauses only the delegate for a change of its grant, and the whole payer for the escrow', async () => {
    const { guard, repository } = guardOver(totals);
    const relay = async () => 'landed';
    await guard.relayTightening({
      scope,
      lowered: { revoked: true },
      acknowledged: true,
      deadline: deadline(),
      relay,
    });
    await guard.relayTightening({
      scope: { ...scope, delegate: null },
      lowered: { maxPerWindow: 1n },
      acknowledged: true,
      deadline: deadline(),
      relay,
    });
    expect(holdOf(repository, 0).delegate).toBe(DELEGATE);
    expect(holdOf(repository, 1).delegate).toBeNull();
  });

  it('leaves the pause to run its full length when the relay ended without a definite answer', async () => {
    const { guard, repository } = guardOver(totals);
    await expect(
      guard.relayTightening({
        scope,
        lowered: { revoked: true },
        acknowledged: true,
        deadline: deadline(),
        relay: async () => {
          throw new Error('receipt timeout');
        },
      }),
    ).rejects.toThrow('receipt timeout');
    expect(repository.landVoucherAdmissionPause).not.toHaveBeenCalled();
    expect(repository.releaseVoucherAdmissionPause).not.toHaveBeenCalled();
  });

  it.each(['SETTLEMENT_RELAYED_INTENT_REFUSED', 'CHAIN_RELAY_NOT_SENT'])(
    'releases the pause at once when the relay ended %s (nothing landed)',
    async (errorCode) => {
      const { guard, repository } = guardOver(totals);
      const refused = Object.assign(new Error(errorCode), { errorCode });
      await expect(
        guard.relayTightening({
          scope,
          lowered: { revoked: true },
          acknowledged: true,
          deadline: deadline(),
          relay: async () => {
            throw refused;
          },
        }),
      ).rejects.toBe(refused);
      expect(repository.releaseVoucherAdmissionPause).toHaveBeenCalledWith('pause-1');
    },
  );

  it('relays a change that lowers nothing without pausing anyone', async () => {
    const { guard, repository } = guardOver(totals);
    await expect(
      guard.relayTightening({
        scope,
        lowered: {},
        acknowledged: false,
        deadline: deadline(),
        relay: async () => 'ok',
      }),
    ).resolves.toBe('ok');
    expect(repository.holdVoucherAdmission).not.toHaveBeenCalled();
  });

  describe('on an escrow with the tighten delay (D-21) it stands down', () => {
    it('relays a stranding change unacknowledged, with no admission pause', async () => {
      const { guard, repository } = guardOver(totals, undefined, true);
      await expect(
        guard.relayTightening({
          scope,
          lowered: { maxPerWindow: 2_000_000n, revoked: true },
          acknowledged: false,
          deadline: deadline(),
          relay: async () => 'landed',
        }),
      ).resolves.toBe('landed');
      expect(repository.holdVoucherAdmission).not.toHaveBeenCalled();
    });

    it('refuses nothing on the intent route, and reads nothing', async () => {
      const { guard, repository } = guardOver(totals, undefined, true);
      await expect(
        guard.refuseIfStranding(scope, { maxPerWindow: 2_000_000n }, false),
      ).resolves.toBeUndefined();
      expect(repository.unsettledVouchers).not.toHaveBeenCalled();
      await expect(guard.tightenDelaySeconds(PAYER)).resolves.toBe(10_800);
    });

    it('stays up until the delay is seen: the same change is refused without it', async () => {
      const { guard } = guardOver(totals);
      await expect(
        guard.refuseIfStranding(scope, { maxPerWindow: 2_000_000n }, false),
      ).rejects.toMatchObject({ errorCode: 'SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK' });
      await expect(guard.tightenDelaySeconds(PAYER)).resolves.toBe(0);
    });

    it('stays up when no tighten-delay port is wired at all', async () => {
      const guard = new UnsettledVoucherGuard({} as never);
      await expect(guard.standsDown(PAYER)).resolves.toBe(false);
    });
  });

  /** Review finding 13: an API started before the migration would refuse every voucher. */
  it('checks the pause table’s shape at boot', async () => {
    const { guard, repository } = guardOver(totals);
    repository.assertAdmissionPauseSchema.mockRejectedValueOnce(new Error('run the migrations'));
    await expect(guard.onApplicationBootstrap()).rejects.toThrow('run the migrations');
  });
});
