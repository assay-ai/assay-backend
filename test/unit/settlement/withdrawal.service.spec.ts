import { AccountId, AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { EscrowIntentKind } from '@modules/settlement/ports/escrow-intent-builder.port';
import { GasGrantRefusal } from '@modules/settlement/ports/withdraw-gas-grant.port';
import {
  EscrowAccountService,
  EscrowState,
} from '@modules/settlement/services/escrow-account.service';
import { ReconciliationService } from '@modules/settlement/services/reconciliation.service';
import { WithdrawalService } from '@modules/settlement/services/withdrawal.service';
import { SettlementErrorCode } from '@modules/settlement/errors/settlement.errors';
import { MoneyUtil } from '@shared/utils/money.util';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { guardOver } from './helpers/unsettled-guard';

const ORG = 'org-11111111-1111-4111-8111-111111111111';
const USDC: AssetId =
  `${CHAIN_IDS.SOLANA_DEVNET}/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` as AssetId;
const ACCOUNT: AccountId = toAccountId(
  CHAIN_IDS.SOLANA_DEVNET,
  'BuyerAccount111111111111111111111111111111',
);

const TRANSACTION = {
  // The unsigned-transaction discriminants. `WithdrawalService` passes this value through
  // untouched, so what the port stamps is what the caller receives.
  namespace: 'solana' as const,
  chainId: CHAIN_IDS.SOLANA_DEVNET,
  kind: 'transaction' as const,
  transactionBase64: 'ZmFrZQ==',
  feePayer: 'BuyerAccount111111111111111111111111111111',
  signers: ['BuyerAccount111111111111111111111111111111'],
  blockhash: 'FakeBlockhash1111111111111111111111111111',
  lastValidBlockHeight: '1000',
};

function escrowState(overrides: Partial<EscrowState> = {}): EscrowState {
  return {
    exists: true,
    account: ACCOUNT,
    escrowPda: null,
    escrowTokenAccount: null,
    balance: MoneyUtil.of(10_000_000n, USDC, 6),
    openHolds: MoneyUtil.of(0n, USDC, 6),
    spendable: MoneyUtil.of(10_000_000n, USDC, 6),
    withdrawRequested: MoneyUtil.of(0n, USDC, 6),
    withdrawAvailableAt: null,
    serverTime: new Date().toISOString(),
    withdrawDelaySeconds: 3_600,
    maxVoucherAmount: MoneyUtil.of(100_000_000n, USDC, 6),
    maxPerWindow: MoneyUtil.of(1_000_000_000n, USDC, 6),
    spentInWindow: MoneyUtil.of(0n, USDC, 6),
    windowStartedAt: null,
    windowSeconds: 86_400,
    seqHigh: '0',
    nextSeq: '1',
    observedAt: new Date().toISOString(),
    // The chain answered — `EscrowState` now says so explicitly, so that an
    // unreadable chain and a readable-but-empty escrow cannot render alike.
    chainReadable: true,
    ...overrides,
  };
}

function buildHarness(overrides?: {
  frozen?: boolean;
  buildIntent?: jest.Mock;
  escrowGet?: jest.Mock;
  grantWithdrawGas?: jest.Mock;
  /** The relayed submit half, recorded in the same `calls` array. */
  submit?: jest.Mock;
  admit?: jest.Mock;
  assertRoom?: jest.Mock;
  guard?: ReturnType<typeof guardOver>['guard'];
}) {
  /*
    Every call this service makes, in one array, in the order it made them.

    The gas grant's whole once-ever budget turns on ORDER — granting before the
    builder has agreed to produce bytes spends it on a buyer who then gets no
    transaction, and the address can never be funded again. Two separate
    `toHaveBeenCalled` assertions cannot see an order; `mock.invocationCallOrder`
    can, but reads as a puzzle. This reads as the sequence.
  */
  const calls: string[] = [];

  const builder = {
    buildIntent:
      overrides?.buildIntent ??
      jest.fn(async () => {
        calls.push('buildIntent');
        return TRANSACTION;
      }),
  };
  const reconciliation = {
    isFrozen: jest.fn(async () => {
      calls.push('isFrozen');
      return overrides?.frozen ?? false;
    }),
  } as unknown as ReconciliationService;
  const escrows = {
    get:
      overrides?.escrowGet ??
      jest.fn(async () => {
        calls.push('escrows.get');
        return escrowState();
      }),
  } as unknown as EscrowAccountService;
  const gasGrants = {
    grantWithdrawGas:
      overrides?.grantWithdrawGas ??
      jest.fn(async () => {
        calls.push('grantWithdrawGas');
        return null;
      }),
  };

  const relayed = {
    submit:
      overrides?.submit ??
      jest.fn(async () => {
        calls.push('relayed.submit');
        return { transactionHash: '0xabc', blockNumber: '11', gasUsed: '65536' };
      }),
  };
  const relayedRate = {
    admit:
      overrides?.admit ??
      jest.fn(async () => {
        calls.push('relayedRate.admit');
      }),
    assertRoom:
      overrides?.assertRoom ??
      jest.fn(async () => {
        calls.push('relayedRate.assertRoom');
      }),
  };

  const service = new WithdrawalService(
    builder as never,
    reconciliation,
    escrows,
    gasGrants as never,
    relayed as never,
    relayedRate as never,
    overrides?.guard ?? guardOver().guard,
  );

  return { service, builder, reconciliation, escrows, gasGrants, relayed, relayedRate, calls };
}

describe('WithdrawalService.buildIntent — delegation', () => {
  it('builds through the port and attaches the escrow state as of that moment', async () => {
    const { service, builder, escrows } = buildHarness();

    const result = await service.buildIntent(ORG, ACCOUNT, USDC, {
      kind: EscrowIntentKind.SET_LIMITS,
      amount: null,
      limits: { maxVoucherAmount: 50_000_000n, maxPerWindow: 500_000_000n },
      destination: null,
    });

    expect(builder.buildIntent).toHaveBeenCalledWith({
      kind: EscrowIntentKind.SET_LIMITS,
      account: ACCOUNT,
      asset: USDC,
      amount: null,
      limits: { maxVoucherAmount: 50_000_000n, maxPerWindow: 500_000_000n },
      destination: null,
    });
    expect(result.transaction).toBe(TRANSACTION);
    expect(escrows.get).toHaveBeenCalledWith(ORG, ACCOUNT, USDC);
  });
});

/**
 * REGRESSION (BUG-D1-06): a relayed request (EIP-712, the platform sends it)
 * was refused for the relay budget only AFTER the payer had signed it.
 */
describe('WithdrawalService.buildIntent — the relay budget, before the signature', () => {
  const typed = { namespace: 'eip155', kind: 'typed-data', relayed: true };

  it('refuses a relayed request when the budget is spent, and grants nothing', async () => {
    const limited = Object.assign(new Error('limit'), {
      errorCode: 'SETTLEMENT_RELAYED_INTENT_RATE_LIMITED',
    });
    const { service, escrows } = buildHarness({
      buildIntent: jest.fn(async () => typed),
      assertRoom: jest.fn(async () => {
        throw limited;
      }),
    });

    await expect(
      service.buildIntent(ORG, ACCOUNT, USDC, {
        kind: EscrowIntentKind.SET_LIMITS,
        amount: null,
        limits: { maxVoucherAmount: 1n, maxPerWindow: 2n },
        destination: null,
      }),
    ).rejects.toBe(limited);
    expect(escrows.get).not.toHaveBeenCalled();
  });

  it('does not consult the relay budget for a transaction the buyer sends', async () => {
    const { service, relayedRate } = buildHarness();
    await service.buildIntent(ORG, ACCOUNT, USDC, {
      kind: EscrowIntentKind.SET_LIMITS,
      amount: null,
      limits: { maxVoucherAmount: 1n, maxPerWindow: 2n },
      destination: null,
    });
    expect(relayedRate.assertRoom).not.toHaveBeenCalled();
  });
});

describe('WithdrawalService.buildIntent — the freeze', () => {
  it('refuses to build REQUEST_WITHDRAW when withdrawals are frozen', async () => {
    const { service, builder } = buildHarness({ frozen: true });

    await expectErrorCodeAsync(
      () =>
        service.buildIntent(ORG, ACCOUNT, USDC, {
          kind: EscrowIntentKind.REQUEST_WITHDRAW,
          amount: MoneyUtil.of(1_000_000n, USDC, 6),
          limits: null,
          destination: null,
        }),
      SettlementErrorCode.SETTLEMENT_WITHDRAWALS_FROZEN,
    );
    expect(builder.buildIntent).not.toHaveBeenCalled();
  });

  it('refuses to build WITHDRAW when withdrawals are frozen', async () => {
    const { service, builder } = buildHarness({ frozen: true });

    await expectErrorCodeAsync(
      () =>
        service.buildIntent(ORG, ACCOUNT, USDC, {
          kind: EscrowIntentKind.WITHDRAW,
          amount: null,
          limits: null,
          destination: null,
        }),
      SettlementErrorCode.SETTLEMENT_WITHDRAWALS_FROZEN,
    );
    expect(builder.buildIntent).not.toHaveBeenCalled();
  });

  it('does NOT freeze SET_LIMITS — it moves no money out of the platform’s control', async () => {
    const { service, builder, reconciliation } = buildHarness({ frozen: true });

    await service.buildIntent(ORG, ACCOUNT, USDC, {
      kind: EscrowIntentKind.SET_LIMITS,
      amount: null,
      limits: { maxVoucherAmount: 1n, maxPerWindow: 1n },
      destination: null,
    });

    expect(builder.buildIntent).toHaveBeenCalledTimes(1);
    expect(reconciliation.isFrozen).not.toHaveBeenCalled();
  });

  it('builds REQUEST_WITHDRAW and WITHDRAW normally when not frozen', async () => {
    const { service, builder } = buildHarness({ frozen: false });

    await service.buildIntent(ORG, ACCOUNT, USDC, {
      kind: EscrowIntentKind.WITHDRAW,
      amount: null,
      limits: null,
      destination: null,
    });

    expect(builder.buildIntent).toHaveBeenCalledTimes(1);
  });
});

describe('the escrow intent transaction is a discriminated UnsignedChainTransaction', () => {
  it('the port’s value reaches the caller with its namespace, chainId and kind intact', async () => {
    // `WithdrawalService` passes the builder's value through untouched — this
    // asserts it does not strip or re-derive the discriminants on the way.
    const { service, builder } = buildHarness();

    const result = await service.buildIntent(ORG, ACCOUNT, USDC, {
      kind: EscrowIntentKind.SET_LIMITS,
      amount: null,
      limits: { maxVoucherAmount: 100_000_000n, maxPerWindow: 1_000_000_000n },
      destination: null,
    });

    expect(result.transaction).toEqual({
      namespace: 'solana',
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      kind: 'transaction',
      transactionBase64: 'ZmFrZQ==',
      feePayer: 'BuyerAccount111111111111111111111111111111',
      signers: ['BuyerAccount111111111111111111111111111111'],
      blockhash: 'FakeBlockhash1111111111111111111111111111',
      lastValidBlockHeight: '1000',
    });
    expect(builder.buildIntent).toHaveBeenCalledTimes(1);
  });
});

/**
 * The EVM withdrawal gas grant, and the one line that joins it to a withdrawal.
 *
 * `EvmGasGrantService` originally shipped with all five controls and **no
 * production caller** — so the mainnet blocker it was built for was still open:
 * a buyer holding USDG and no ETH on `eip155:46630` could request a withdrawal,
 * wait out the delay, receive perfectly valid unsigned bytes, and have no way to
 * send them.
 *
 * These cases are about the SEAM, not about the grant's own bounds — those are
 * `test/unit/chains/evm/evm-gas-grant.spec.ts` and
 * `test/integration/database/evm-gas-grants.integration.spec.ts`, and nothing
 * here may stand in for them. What is provable only here is *when* the grant is
 * consulted, *what account* it is asked about, and what happens to the
 * withdrawal when it fails.
 */
describe('WithdrawalService.buildIntent — the withdrawal gas grant', () => {
  const GRANTED = {
    kind: 'GRANTED' as const,
    hash: `0x${'ab'.repeat(32)}`,
    wei: 7_200_000_000_000n,
  };

  async function claim(service: WithdrawalService) {
    return service.buildIntent(ORG, ACCOUNT, USDC, {
      kind: EscrowIntentKind.WITHDRAW,
      amount: null,
      limits: null,
      destination: null,
    });
  }

  it('consults the grant on WITHDRAW and reports its outcome', async () => {
    const grantWithdrawGas = jest.fn().mockResolvedValue(GRANTED);
    const { service } = buildHarness({ grantWithdrawGas });

    const result = await claim(service);

    expect(grantWithdrawGas).toHaveBeenCalledTimes(1);
    // The whole join, in one assertion: the outcome the port produced reaches
    // the caller intact, and the transaction comes back beside it.
    expect(result.gasGrant).toEqual(GRANTED);
    expect(result.transaction).toBe(TRANSACTION);
  });

  it('asks about the account the transaction was built for, and passes no other address', async () => {
    /*
      The binding threat model: a full leak of every env-held private key must
      not lose user money. The relayer key is what such a leak takes, and
      everything it can reach through this seam is a transfer to the account
      under examination — so the account this service hands the grant must be
      the same one it handed the builder, which `EscrowController` takes from
      the session and never from the request body.

      A degenerate that funded a recipient of its own choosing would need a
      second address here. There is not one, and this pins that.
    */
    const grantWithdrawGas = jest.fn().mockResolvedValue(GRANTED);
    const { service, builder } = buildHarness({ grantWithdrawGas });

    await claim(service);

    expect(grantWithdrawGas).toHaveBeenCalledWith(ORG, ACCOUNT);
    expect(builder.buildIntent).toHaveBeenCalledWith(expect.objectContaining({ account: ACCOUNT }));
    // Exactly two arguments — an organization and the account. Nothing on this
    // path names a recipient, so nothing can be induced to.
    expect(grantWithdrawGas.mock.calls[0]).toHaveLength(2);
  });

  it('grants only AFTER the builder has produced bytes', async () => {
    /*
      The grant is once per address in the lifetime of the deployment and there
      is no refund. Consulting it first would spend that budget on a buyer whose
      intent then failed to build — a destination naming somebody else, an RPC
      that could not be read — leaving them funded, transactionless and
      permanently ineligible.

      The builder is also what ENFORCES the matured-withdrawal precondition the
      grant shares, so past `buildIntent` that precondition is established by
      the code path rather than hoped for.
    */
    const { service, calls } = buildHarness();

    await claim(service);

    expect(calls).toEqual(['isFrozen', 'buildIntent', 'grantWithdrawGas', 'escrows.get']);
  });

  it('spends nothing when the builder refuses', async () => {
    // The case the ordering exists for, made observable: an intent that cannot
    // be built must leave the address's once-ever budget untouched.
    const buildIntent = jest.fn().mockRejectedValue(new Error('WITHDRAW_NOT_YET_AVAILABLE'));
    const grantWithdrawGas = jest.fn().mockResolvedValue(GRANTED);
    const { service } = buildHarness({ buildIntent, grantWithdrawGas });

    await expect(claim(service)).rejects.toThrow('WITHDRAW_NOT_YET_AVAILABLE');
    expect(grantWithdrawGas).not.toHaveBeenCalled();
  });

  it('spends nothing when withdrawals are frozen', async () => {
    // The freeze is the platform's only veto left, and it fires before anything
    // is built. Funding an address for a withdrawal the platform just refused to
    // build would burn the budget on a transaction that does not exist.
    const grantWithdrawGas = jest.fn().mockResolvedValue(GRANTED);
    const { service } = buildHarness({ frozen: true, grantWithdrawGas });

    await expectErrorCodeAsync(
      () => claim(service),
      SettlementErrorCode.SETTLEMENT_WITHDRAWALS_FROZEN,
    );
    expect(grantWithdrawGas).not.toHaveBeenCalled();
  });

  it.each([
    ['SET_LIMITS', EscrowIntentKind.SET_LIMITS],
    ['REQUEST_WITHDRAW', EscrowIntentKind.REQUEST_WITHDRAW],
  ])('does not consult the grant on %s', async (_name, kind) => {
    /*
      Neither is the transaction that needs native gas. On eip155 both are
      RELAYED EIP-712 signature requests — the buyer signs, the relayer sends,
      the buyer pays no gas at all — so a grant here would spend the once-ever
      budget on a step that never needed it, and the buyer would then reach the
      one step that does with `ALREADY_GRANTED`. That is the worst outcome
      available: the feature would be strictly worse than not existing.
    */
    const grantWithdrawGas = jest.fn().mockResolvedValue(GRANTED);
    const { service } = buildHarness({ grantWithdrawGas });

    const result = await service.buildIntent(ORG, ACCOUNT, USDC, {
      kind,
      amount: MoneyUtil.of(1_000_000n, USDC, 6),
      limits: { maxVoucherAmount: 1n, maxPerWindow: 1n },
      destination: null,
    });

    expect(grantWithdrawGas).not.toHaveBeenCalled();
    expect(result.gasGrant).toBeNull();
  });

  it('reports a refusal as a refusal, alongside valid bytes', async () => {
    // A refusal is a control WORKING, and it is not a reason to withhold the
    // withdrawal: a buyer who already holds gas gets `BUYER_HAS_GAS` and a
    // transaction they can send immediately.
    const grantWithdrawGas = jest
      .fn()
      .mockResolvedValue({ kind: 'REFUSED', reason: GasGrantRefusal.BUYER_HAS_GAS });
    const { service } = buildHarness({ grantWithdrawGas });

    const result = await claim(service);

    expect(result.gasGrant).toEqual({ kind: 'REFUSED', reason: GasGrantRefusal.BUYER_HAS_GAS });
    expect(result.transaction).toBe(TRANSACTION);
  });

  it('reports null on a chain that has no gas grant', async () => {
    // Solana. `withdraw` there is signed and paid for out of SOL the account
    // already holds, so the question does not arise — which is materially
    // different from a refusal, and a console that conflated the two would print
    // an EVM apology on a Solana withdrawal.
    const grantWithdrawGas = jest.fn().mockResolvedValue(null);
    const { service } = buildHarness({ grantWithdrawGas });

    expect((await claim(service)).gasGrant).toBeNull();
  });

  it('degrades to UNAVAILABLE when the grant throws, and still returns the transaction', async () => {
    /*
      This class's rule is that a buyer's exit does not depend on the platform's
      cooperation. A throw escaping here would break it in exactly the case it
      was written for — an RPC outage, an unreachable database, an unconfigured
      cap — and would deny a withdrawal to a buyer who has their own ETH and
      never needed the faucet at all.

      `UNAVAILABLE` and not a seventh REFUSED reason: a refusal means a control
      fired and the system is working, and an outage must not be able to
      impersonate one.
    */
    const grantWithdrawGas = jest.fn().mockRejectedValue(new Error('rpc is down'));
    const { service } = buildHarness({ grantWithdrawGas });

    const result = await claim(service);

    expect(result.gasGrant).toEqual({ kind: 'UNAVAILABLE' });
    expect(result.transaction).toBe(TRANSACTION);
    expect(result.escrow).not.toBeNull();
  });
});

/**
 * REGRESSION (BUG-D1-07): lowering the escrow's OWN limits strands every
 * signer's unredeemed vouchers just as lowering a delegate's does — the
 * escrow's limits bind the payer's key and every delegate at redemption.
 */
describe('WithdrawalService — lowering escrow limits with payments in flight (BUG-D1-07)', () => {
  const inFlight = {
    count: 2,
    total: 600_000n,
    largest: 500_000n,
    redeemableUntil: new Date(Date.now() + 30 * 60_000),
    redeemedSince: 0n,
  };
  const standing = () =>
    escrowState({
      maxVoucherAmount: MoneyUtil.of(1_000_000n, USDC, 6),
      maxPerWindow: MoneyUtil.of(10_000_000n, USDC, 6),
      spentInWindow: MoneyUtil.of(2_000_000n, USDC, 6),
      windowStartedAt: new Date().toISOString(),
    });
  const setLimits = (
    maxVoucherAmount: bigint,
    maxPerWindow: bigint,
    acknowledgeUnsettled = false,
  ) => ({
    kind: EscrowIntentKind.SET_LIMITS,
    amount: null,
    limits: { maxVoucherAmount, maxPerWindow },
    destination: null,
    acknowledgeUnsettled,
  });

  it('refuses a per-payment limit below an unredeemed voucher, before building anything', async () => {
    const { service, builder } = buildHarness({
      guard: guardOver(inFlight).guard,
      escrowGet: jest.fn(async () => standing()),
      buildIntent: jest.fn(async () => TRANSACTION),
    });
    await expect(
      service.buildIntent(ORG, ACCOUNT, USDC, setLimits(400_000n, 10_000_000n)),
    ).rejects.toMatchObject({
      errorCode: SettlementErrorCode.SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK,
    });
    expect(builder.buildIntent).toHaveBeenCalledTimes(1);
  });

  it('refuses a window below counter + in flight, and builds it when acknowledged', async () => {
    const harness = () =>
      buildHarness({
        guard: guardOver(inFlight).guard,
        escrowGet: jest.fn(async () => standing()),
        buildIntent: jest.fn(async () => TRANSACTION),
      });
    await expect(
      harness().service.buildIntent(ORG, ACCOUNT, USDC, setLimits(1_000_000n, 2_500_000n)),
    ).rejects.toMatchObject({
      errorCode: SettlementErrorCode.SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK,
    });
    await expect(
      harness().service.buildIntent(ORG, ACCOUNT, USDC, setLimits(1_000_000n, 2_600_000n)),
    ).resolves.toBeDefined();
    await expect(
      harness().service.buildIntent(ORG, ACCOUNT, USDC, setLimits(1_000_000n, 2_500_000n, true)),
    ).resolves.toBeDefined();
  });

  it('never refuses a raise, whatever is in flight', async () => {
    const { service } = buildHarness({
      guard: guardOver({ ...inFlight, total: 50_000_000n }).guard,
      escrowGet: jest.fn(async () => standing()),
      buildIntent: jest.fn(async () => TRANSACTION),
    });
    await expect(
      service.buildIntent(ORG, ACCOUNT, USDC, setLimits(2_000_000n, 20_000_000n)),
    ).resolves.toBeDefined();
  });
});
