import { ChainErrors } from '@modules/chains/errors/chains.errors';
import { AccountId, AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { EscrowChainBalance } from '@modules/ledger/ports/escrow-balance-reader.port';
import { PaymentErrorCode, PaymentErrors } from '@modules/payment/errors/payment.errors';
import { SettlementErrorCode } from '@modules/settlement/errors/settlement.errors';
import { EscrowAccountService } from '@modules/settlement/services/escrow-account.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const ORG = 'org-11111111-1111-4111-8111-111111111111';
const USDC: AssetId =
  `${CHAIN_IDS.SOLANA_DEVNET}/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` as AssetId;
const ACCOUNT: AccountId = toAccountId(
  CHAIN_IDS.SOLANA_DEVNET,
  'BuyerAccount111111111111111111111111111111',
);

/**
 * The mirror row's two addresses, deliberately unmistakable for each other. A
 * fixture where both carried the same value would pass a swapped pair by
 * construction — which is how the swap survived the multichain rename.
 */
const ESCROW_ACCOUNT_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:TheEscrowAccountItself11111';
const ESCROW_ASSET_ACCOUNT_ID =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:WhereTheBalanceActuallySits';
const MIRROR_ROW = {
  escrowAccountId: ESCROW_ACCOUNT_ID,
  escrowAssetAccountId: ESCROW_ASSET_ACCOUNT_ID,
};

function chainBalance(overrides: Partial<EscrowChainBalance> = {}): EscrowChainBalance {
  return {
    balance: MoneyUtil.of(10_000_000n, USDC, 6),
    seqHigh: 0n,
    withdrawRequested: 0n,
    withdrawAvailableAt: 0,
    maxVoucherAmount: 100_000_000n,
    maxPerWindow: 1_000_000_000n,
    spentInWindow: 0n,
    windowStartedAt: 0,
    observedAt: new Date('2023-11-14T22:00:00.000Z'),
    ...overrides,
  };
}

function buildService(options?: {
  reading?: EscrowChainBalance | null;
  readerThrows?: unknown;
  openHoldsAtomic?: bigint;
  withdrawDelaySeconds?: number;
  nextSeq?: bigint | null;
  mirrorRow?: { escrowAccountId: string; escrowAssetAccountId: string } | null;
  /** What `Config.stake_mint` could not be read as — a devnet layout skew. */
  escrowAssetThrows?: unknown;
  /** A Postgres failure, which is NOT an unreadable chain and must not be reported as one. */
  peekNextSeqThrows?: unknown;
  /**
   * The other Postgres failure, and the one that matters: `sumOpenByAccount`
   * is read ONLY on the assembled path, so a `catch` that wrapped the whole
   * method would swallow it — where `peekNextSeqThrows` would rethrow from
   * inside the degraded path itself and pass such a `catch` by accident.
   */
  holdsThrow?: unknown;
  withdrawDelayThrows?: unknown;
}) {
  const reader = {
    read: options?.readerThrows
      ? jest.fn().mockRejectedValue(options.readerThrows)
      : jest
          .fn()
          .mockResolvedValue(options?.reading === undefined ? chainBalance() : options.reading),
    readMany: jest.fn(),
    escrowAddresses: jest.fn(),
  };
  const holds = {
    sumOpenByAccount: options?.holdsThrow
      ? jest.fn().mockRejectedValue(options.holdsThrow)
      : jest.fn().mockResolvedValue(options?.openHoldsAtomic ?? 0n),
  };
  // One `buyer_escrows` row answers both the mirror ids and `next_seq`
  // (`peekNextSeq` is that row's column): no row when `nextSeq` is null.
  const nextSeq = options?.nextSeq === undefined ? 1n : options.nextSeq;
  const escrows = {
    findByAccount: options?.peekNextSeqThrows
      ? jest.fn().mockRejectedValue(options.peekNextSeqThrows)
      : jest
          .fn()
          .mockResolvedValue(
            nextSeq === null ? null : { ...(options?.mirrorRow ?? {}), nextSeq: String(nextSeq) },
          ),
  };
  const builder = {
    escrowAsset: options?.escrowAssetThrows
      ? jest.fn().mockRejectedValue(options.escrowAssetThrows)
      : jest.fn().mockResolvedValue({ asset: USDC, decimals: 6 }),
    withdrawDelaySeconds: options?.withdrawDelayThrows
      ? jest.fn().mockRejectedValue(options.withdrawDelayThrows)
      : jest.fn().mockResolvedValue(options?.withdrawDelaySeconds ?? 3_600),
    buildIntent: jest.fn(),
  };

  const service = new EscrowAccountService(
    reader as never,
    holds as never,
    escrows as never,
    builder as never,
  );

  return { service, reader, holds, escrows, builder };
}

describe('EscrowAccountService.get', () => {
  /**
   * Before this, `mirrorRow` was an option on the harness that **no test ever
   * set**, so both branches of the row→response mapping were unexercised — and
   * the multichain rename went straight through that line. Swapping the pair
   * left the whole suite green while `GET /escrow` told the buyer their balance sat
   * at the escrow's owner and their `pay_to` was the token account: both wrong,
   * both plausible-looking, and neither observable from this repository.
   */
  describe('the escrow account and the escrow ASSET account do not get crossed', () => {
    it('reports each mirror column under the response field that means it', async () => {
      const { service } = buildService({ mirrorRow: MIRROR_ROW });

      const state = await service.get(ORG, ACCOUNT, USDC);

      expect(state.escrowPda).toBe(ESCROW_ACCOUNT_ID);
      expect(state.escrowTokenAccount).toBe(ESCROW_ASSET_ACCOUNT_ID);
      expect(state.escrowPda).not.toBe(ESCROW_ASSET_ACCOUNT_ID);
      expect(state.escrowTokenAccount).not.toBe(ESCROW_ACCOUNT_ID);
    });

    it('does the same on the no-chain-reading branch, which returns from a different line', async () => {
      const { service } = buildService({ reading: null, mirrorRow: MIRROR_ROW });

      const state = await service.get(ORG, ACCOUNT, USDC);

      expect(state.exists).toBe(false);
      expect(state.escrowPda).toBe(ESCROW_ACCOUNT_ID);
      expect(state.escrowTokenAccount).toBe(ESCROW_ASSET_ACCOUNT_ID);
    });

    it('answers null for both when this buyer has no mirror row at all', async () => {
      const { service } = buildService({ mirrorRow: null });

      const state = await service.get(ORG, ACCOUNT, USDC);

      expect(state.escrowPda).toBeNull();
      expect(state.escrowTokenAccount).toBeNull();
    });
  });

  it('reads the buyer_escrows row once for both next_seq and the mirror ids (B7)', async () => {
    for (const reading of [chainBalance(), null]) {
      const { service, escrows } = buildService({ reading, mirrorRow: MIRROR_ROW, nextSeq: 42n });

      const state = await service.get(ORG, ACCOUNT, USDC);

      expect(escrows.findByAccount).toHaveBeenCalledTimes(1);
      expect(state.nextSeq).toBe('42');
      expect(state.escrowPda).toBe(ESCROW_ACCOUNT_ID);
    }
    const { service, escrows } = buildService({ readerThrows: new Error('rpc down'), nextSeq: 7n });
    const degraded = await service.getForConsole(ORG, ACCOUNT);
    expect(escrows.findByAccount).toHaveBeenCalledTimes(1);
    expect(degraded.nextSeq).toBe('7');
  });

  it('answers next_seq 0 when there is no buyer_escrows row', async () => {
    const { service } = buildService({ nextSeq: null });
    expect((await service.get(ORG, ACCOUNT, USDC)).nextSeq).toBe('0');
  });

  it('returns a server-supplied INSTANT for the withdrawal, never a delay the client adds', async () => {
    // `Config.withdraw_delay_seconds` is movable on chain between
    // MIN_WITHDRAW_DELAY_SECONDS (1h) and MAX (24h). A console that rendered
    // `now + delay` would show a countdown that is quietly wrong after any
    // parameter change — and wrong in the direction that tells a buyer their
    // money is available before it is. The instant comes off
    // `BuyerEscrow.withdraw_available_at`, which the program froze at request
    // time for exactly this reason.
    const { service } = buildService({
      reading: chainBalance({ withdrawRequested: 5_000_000n, withdrawAvailableAt: 1_700_003_600 }),
    });

    const state = await service.get(ORG, ACCOUNT, USDC);

    // 1_700_003_600 unix seconds — computed, not copied.
    expect(state.withdrawAvailableAt).toBe('2023-11-14T23:13:20.000Z');
    expect(state.serverTime).toBeDefined();
    expect(state.withdrawRequested?.amount).toBe('5000000');
  });

  it('reports withdrawAvailableAt as null when nothing is pending', async () => {
    const { service } = buildService({
      reading: chainBalance({ withdrawRequested: 0n, withdrawAvailableAt: 0 }),
    });
    const state = await service.get(ORG, ACCOUNT, USDC);
    expect(state.withdrawAvailableAt).toBeNull();
    expect(state.withdrawRequested?.amount).toBe('0');
  });

  it('says the escrow does not exist rather than reporting a zero balance', async () => {
    // Absent is not zero. A buyer with no escrow needs one opened (which a
    // deposit does); a buyer with an empty one needs money.
    const { service } = buildService({ reading: null });

    const state = await service.get(ORG, ACCOUNT, USDC);

    expect(state.exists).toBe(false);
    expect(state.balance).toBeNull();
    expect(state.maxVoucherAmount).toBeNull();
  });

  it('publishes both limits and the window meter, so the brake is visible', async () => {
    const { service } = buildService({
      reading: chainBalance({
        maxVoucherAmount: 100_000_000n,
        maxPerWindow: 1_000_000_000n,
        spentInWindow: 250_000_000n,
        windowStartedAt: 1_700_000_000,
      }),
    });

    const state = await service.get(ORG, ACCOUNT, USDC);

    expect(state.maxVoucherAmount?.amount).toBe('100000000');
    expect(state.maxPerWindow?.amount).toBe('1000000000');
    expect(state.spentInWindow?.amount).toBe('250000000');
    expect(state.windowStartedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(state.windowSeconds).toBe(86_400);
  });

  it('reports a limit of zero as zero, and never as "unlimited"', async () => {
    // `0` is "refuse every redeem", not "unlimited". A
    // console that rendered it as "no limit" would tell a buyer they were
    // unprotected when in fact no call of theirs could be paid at all.
    const { service } = buildService({
      reading: chainBalance({ maxVoucherAmount: 0n, maxPerWindow: 0n }),
    });
    const state = await service.get(ORG, ACCOUNT, USDC);
    expect(state.maxVoucherAmount?.amount).toBe('0');
    expect(state.maxPerWindow?.amount).toBe('0');
  });

  it('returns 503 rather than a stale picture when the chain cannot be read', async () => {
    // The MONEY path. `WithdrawalService.buildIntent` snapshots this beside
    // the bytes it built, and a snapshot that might be wrong is worse than no
    // snapshot. `getForConsole` is the read that degrades; this one does not.
    const { service } = buildService({ readerThrows: PaymentErrors.escrowBalanceUnavailable({}) });
    await expectErrorCodeAsync(
      () => service.get(ORG, ACCOUNT, USDC),
      PaymentErrorCode.PAYMENT_ESCROW_BALANCE_UNAVAILABLE,
    );
  });

  it('computes spendable as chain minus open holds, floored at zero', async () => {
    const { service } = buildService({
      reading: chainBalance({ balance: MoneyUtil.of(10_000_000n, USDC, 6) }),
      openHoldsAtomic: 3_000_000n,
    });

    const state = await service.get(ORG, ACCOUNT, USDC);

    expect(state.balance?.amount).toBe('10000000');
    expect(state.openHolds?.amount).toBe('3000000');
    expect(state.spendable?.amount).toBe('7000000');
  });

  it('floors spendable at zero when holds exceed the chain balance', async () => {
    const { service } = buildService({
      reading: chainBalance({ balance: MoneyUtil.of(1_000_000n, USDC, 6) }),
      openHoldsAtomic: 5_000_000n,
    });

    const state = await service.get(ORG, ACCOUNT, USDC);

    expect(state.spendable?.amount).toBe('0');
  });

  it('reports seqHigh from the chain and nextSeq from the Postgres mirror', async () => {
    const { service } = buildService({
      reading: chainBalance({ seqHigh: 41n }),
      nextSeq: 43n,
    });

    const state = await service.get(ORG, ACCOUNT, USDC);

    expect(state.seqHigh).toBe('41');
    expect(state.nextSeq).toBe('43');
  });

  it('reports nextSeq as "0" when the mirror has no row yet', async () => {
    const { service } = buildService({ reading: null, nextSeq: null });

    const state = await service.get(ORG, ACCOUNT, USDC);

    expect(state.nextSeq).toBe('0');
  });
});

/**
 * A measured devnet failure, reproduced exactly: the deployed program
 * carries a `Config` older than this branch's decoder (154 bytes against the
 * 243 the layout now needs), so the codec runs out of bytes mid-struct. Every
 * one of `GET /escrow` and the three `*-intent` routes resolves
 * `Config.stake_mint` first, which is why all four answered the same 500.
 */
const CONFIG_LAYOUT_SKEW = ChainErrors.accountLayoutUnexpected({
  account: 'JDCR4dmWRKwZoSV5kJAXpLrGh4W7zgYhURzrU4oaNciT',
  expected: 'a settlement program Config account',
  actual: 'Codec [u64] expected 8 bytes, got 1',
});

describe('EscrowAccountService.assetFor refuses by name', () => {
  it('answers SETTLEMENT_ESCROW_CHAIN_UNREADABLE, not the decoder’s own error', async () => {
    // The three `*-intent` routes go through here and cannot degrade: each
    // builds a transaction that NAMES the mint. What changes is that the
    // refusal is a code a console can branch on rather than a codec message.
    const { service } = buildService({ escrowAssetThrows: CONFIG_LAYOUT_SKEW });

    await expectErrorCodeAsync(
      () => service.assetFor(ACCOUNT),
      SettlementErrorCode.SETTLEMENT_ESCROW_CHAIN_UNREADABLE,
    );
  });

  it('carries the underlying failure in the message, so the deploy skew is still diagnosable', async () => {
    const { service } = buildService({ escrowAssetThrows: CONFIG_LAYOUT_SKEW });

    let thrown: unknown;
    try {
      await service.assetFor(ACCOUNT);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toContain('Codec [u64] expected 8 bytes, got 1');
    expect((thrown as Error).message).toContain(ACCOUNT);
  });

  it('resolves the mint normally when the chain answers', async () => {
    const { service } = buildService({});

    await expect(service.assetFor(ACCOUNT)).resolves.toBe(USDC);
  });
});

/**
 * `GET /escrow` — the buyer's screen, which renders whatever it can.
 *
 * The three states this block exists to keep apart, because a fixture that
 * merged any two of them would prove nothing:
 *
 * ```text
 * readable, funded     chainReadable: true   exists: true   balance: "10000000"
 * readable, zero       chainReadable: true   exists: true   balance: "0"
 * readable, no escrow  chainReadable: true   exists: false  balance: null
 * UNREADABLE           chainReadable: false  exists: null   balance: null
 * ```
 */
describe('EscrowAccountService.getForConsole degrades instead of 500ing', () => {
  it('reports chainReadable: false rather than throwing when Config cannot be decoded', async () => {
    const { service } = buildService({ escrowAssetThrows: CONFIG_LAYOUT_SKEW });

    const state = await service.getForConsole(ORG, ACCOUNT);

    expect(state.chainReadable).toBe(false);
  });

  it('nulls every chain-derived field — unknown, never zero', async () => {
    const { service } = buildService({ escrowAssetThrows: CONFIG_LAYOUT_SKEW });

    const state = await service.getForConsole(ORG, ACCOUNT);

    expect(state.exists).toBeNull();
    expect(state.balance).toBeNull();
    expect(state.openHolds).toBeNull();
    expect(state.spendable).toBeNull();
    expect(state.withdrawRequested).toBeNull();
    expect(state.maxVoucherAmount).toBeNull();
    expect(state.maxPerWindow).toBeNull();
    expect(state.spentInWindow).toBeNull();
    expect(state.withdrawAvailableAt).toBeNull();
    expect(state.windowStartedAt).toBeNull();
    // `'0'` here would be a claim about `BuyerEscrow.seq_high` this request
    // never read, and the voucher `seq` a client would issue against it.
    expect(state.seqHigh).toBeNull();
    expect(state.observedAt).toBeNull();
  });

  it('still serves the database half of the screen', async () => {
    // The point of degrading rather than refusing: these four come out of
    // Postgres and are unaffected by any chain, so a buyer opening this screen
    // during a chain incident still sees their escrow addresses and the next
    // voucher sequence.
    const { service } = buildService({
      escrowAssetThrows: CONFIG_LAYOUT_SKEW,
      mirrorRow: MIRROR_ROW,
      nextSeq: 43n,
    });

    const state = await service.getForConsole(ORG, ACCOUNT);

    expect(state.account).toBe(ACCOUNT);
    expect(state.escrowPda).toBe(ESCROW_ACCOUNT_ID);
    expect(state.escrowTokenAccount).toBe(ESCROW_ASSET_ACCOUNT_ID);
    expect(state.nextSeq).toBe('43');
    expect(state.serverTime).toBeDefined();
    // A program constant on both chains, so an unreadable `Config` does not
    // take the next request's waiting time with it.
    expect(state.withdrawDelaySeconds).toBe(3_600);
    expect(state.windowSeconds).toBe(86_400);
  });

  it('degrades the same way when the escrow reading itself is unavailable', async () => {
    // `PAYMENT_ESCROW_BALANCE_UNAVAILABLE` is the reader failing closed past
    // its staleness ceiling. On the money path that is still a 503 (see
    // `EscrowAccountService.get` below); on the screen it is an unknown.
    const { service } = buildService({
      readerThrows: PaymentErrors.escrowBalanceUnavailable({ account: ACCOUNT }),
    });

    const state = await service.getForConsole(ORG, ACCOUNT);

    expect(state.chainReadable).toBe(false);
    expect(state.balance).toBeNull();
  });

  it('reports chainReadable: TRUE when the chain answers — the flag is measured, not stamped', async () => {
    // The degenerate implementation of this whole change is a method that
    // returns `chainReadable: false` unconditionally. This is the assertion
    // that kills it.
    const { service } = buildService({ reading: chainBalance() });

    const state = await service.getForConsole(ORG, ACCOUNT);

    expect(state.chainReadable).toBe(true);
    expect(state.exists).toBe(true);
    expect(state.balance?.amount).toBe('10000000');
    expect(state.seqHigh).toBe('0');
    expect(state.observedAt).toBe('2023-11-14T22:00:00.000Z');
  });

  it('keeps "the chain says there is no escrow" apart from "the chain could not be read"', async () => {
    const { service } = buildService({ reading: null });

    const state = await service.getForConsole(ORG, ACCOUNT);

    // The chain answered. What it said was: nothing at those seeds.
    expect(state.chainReadable).toBe(true);
    expect(state.exists).toBe(false);
    expect(state.balance).toBeNull();
  });

  it('keeps "readable and empty" apart from both', async () => {
    const { service } = buildService({
      reading: chainBalance({ balance: MoneyUtil.of(0n, USDC, 6) }),
    });

    const state = await service.getForConsole(ORG, ACCOUNT);

    expect(state.chainReadable).toBe(true);
    expect(state.exists).toBe(true);
    // A zero balance is a fact, and it is not the null an unreadable chain
    // produces two tests up.
    expect(state.balance?.amount).toBe('0');
    expect(state.spendable?.amount).toBe('0');
  });

  it('does NOT report a Postgres outage as an unreadable chain, on the assembled path', async () => {
    // `sumOpenByAccount` is read only once the chain HAS answered, so this is
    // the failure a `catch` around the whole method would swallow — and the
    // one that would then report `chainReadable: false` about a chain that
    // answered perfectly. The `peekNextSeq` case below cannot prove that on
    // its own: the degraded path reads `peekNextSeq` too, so it rethrows from
    // inside the fallback and passes a too-wide `catch` by accident.
    const failure = new Error('deadlock detected');
    const { service } = buildService({ reading: chainBalance(), holdsThrow: failure });

    await expect(service.getForConsole(ORG, ACCOUNT)).rejects.toBe(failure);
  });

  it('does NOT report a Postgres outage as an unreadable chain', async () => {
    // The catch wraps the two chain calls and nothing else. A `catch` around
    // everything would answer "the chain is unreadable" to a question about
    // the database — the exact shape of gate this project keeps being bitten
    // by — and a buyer would read "chain unavailable" while their own escrow
    // was perfectly readable.
    const failure = new Error('connection terminated unexpectedly');
    const { service } = buildService({ peekNextSeqThrows: failure });

    await expect(service.getForConsole(ORG, ACCOUNT)).rejects.toBe(failure);
  });
});

describe('EscrowAccountService lifetime totals (B7)', () => {
  it('publishes the chain lifetime counters, which add up to the balance', async () => {
    const { service } = buildService({
      reading: chainBalance({
        balance: MoneyUtil.of(13_240_000n, USDC, 6),
        lifetime: { funded: 20_000_000n, redeemed: 6_760_000n, withdrawn: 0n },
      }),
    });

    const state = await service.getForConsole(ORG, ACCOUNT);

    expect(state.lifetime).toEqual({
      deposited: MoneyUtil.of(20_000_000n, USDC, 6),
      spent: MoneyUtil.of(6_760_000n, USDC, 6),
      withdrawn: MoneyUtil.of(0n, USDC, 6),
    });
    const { deposited, spent, withdrawn } = state.lifetime!;
    expect(BigInt(deposited.amount) - BigInt(spent.amount) - BigInt(withdrawn.amount)).toBe(
      BigInt(state.balance!.amount),
    );
  });

  it('is null where the chain keeps no counters, with no escrow, and when unreadable', async () => {
    expect((await buildService().service.getForConsole(ORG, ACCOUNT)).lifetime).toBeNull();
    expect(
      (await buildService({ reading: null }).service.getForConsole(ORG, ACCOUNT)).lifetime,
    ).toBeNull();
    expect(
      (
        await buildService({ readerThrows: new Error('rpc down') }).service.getForConsole(
          ORG,
          ACCOUNT,
        )
      ).lifetime,
    ).toBeNull();
  });
});

describe('EscrowAccountService — uncreditedOnChain and withdrawalsFrozen (A3, D16)', () => {
  function withLedger(options: {
    row?: { available: string; held: string; pending: string } | null;
    heldOnChain?: bigint;
    frozen?: boolean | Error;
    reading?: EscrowChainBalance | null;
  }) {
    const base = buildService({ reading: options.reading });
    const balances = { findOneRow: jest.fn().mockResolvedValue(options.row ?? null) };
    const intents = {
      sumHeldOnChainByAccounts: jest
        .fn()
        .mockResolvedValue(new Map([[ACCOUNT, options.heldOnChain ?? 0n]])),
    };
    const reconciliation = {
      isFrozen:
        options.frozen instanceof Error
          ? jest.fn().mockRejectedValue(options.frozen)
          : jest.fn().mockResolvedValue(options.frozen ?? false),
    };
    const service = new EscrowAccountService(
      base.reader as never,
      base.holds as never,
      base.escrows as never,
      base.builder as never,
      balances as never,
      intents as never,
      reconciliation as never,
    );
    return { service, balances, intents, reconciliation };
  }

  it('reports what the chain holds beyond the ledger mirror, as the reconciler compares', async () => {
    // chain 10.00; ledger available 4.00 + held 0.03 (0.01 of it already in the escrow hold) + pending 0.
    const { service, balances } = withLedger({
      row: { available: '4000000', held: '30000', pending: '0' },
      heldOnChain: 10_000n,
    });

    const state = await service.getForConsole(ORG, ACCOUNT);

    expect(balances.findOneRow).toHaveBeenCalledWith(ORG, ACCOUNT, USDC);
    expect(state.uncreditedOnChain).toEqual(MoneyUtil.of(5_980_000n, USDC, 6));
    expect(state.withdrawalsFrozen).toBe(false);
  });

  it('floors at zero when the ledger mirrors more than the chain holds', async () => {
    const { service } = withLedger({ row: { available: '20000000', held: '0', pending: '0' } });
    const state = await service.getForConsole(ORG, ACCOUNT);
    expect(state.uncreditedOnChain).toEqual(MoneyUtil.of(0n, USDC, 6));
  });

  it('says frozen when the last reconciliation froze withdrawals, null when unknown', async () => {
    const frozen = await withLedger({ frozen: true }).service.getForConsole(ORG, ACCOUNT);
    expect(frozen.withdrawalsFrozen).toBe(true);

    const unknown = await withLedger({ frozen: new Error('db down') }).service.getForConsole(
      ORG,
      ACCOUNT,
    );
    expect(unknown.withdrawalsFrozen).toBeNull();
  });

  it('is null for both without a reading, and null without the ledger wired', async () => {
    const unreadable = buildService({ readerThrows: new Error('rpc down') });
    const state = await unreadable.service.getForConsole(ORG, ACCOUNT);
    expect(state.uncreditedOnChain).toBeNull();
    expect(state.withdrawalsFrozen).toBeNull();

    const bare = await buildService().service.getForConsole(ORG, ACCOUNT);
    expect(bare.uncreditedOnChain).toBeNull();
    expect(bare.withdrawalsFrozen).toBeNull();

    const none = await withLedger({ reading: null }).service.getForConsole(ORG, ACCOUNT);
    expect(none.uncreditedOnChain).toBeNull();
    expect(none.withdrawalsFrozen).toBe(false);
  });
});
