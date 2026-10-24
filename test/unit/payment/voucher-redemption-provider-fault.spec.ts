import { randomUUID } from 'node:crypto';

import { RedeemableIntent } from '@database/postgres/repositories/payment-intent.repository';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import {
  PROVIDER_FORFEIT_PREFIX,
  VoucherRedemptionService,
} from '@modules/payment/services/voucher-redemption.service';

import { addBlock, noBlocks } from '../helpers/blocklist';

/**
 * Who loses a voucher that cannot be collected when the PROVIDER is at fault
 * (review 2026-10-15, M1, M3 and L4). The owner's rule: the platform never
 * pays a provider. A provider below its minimum stake, or blocked (on the
 * platform or on chain), forfeits — the buyer's hold is released and nobody
 * is credited. A blocked buyer freezes collection, also when the provider is
 * blocked too.
 */

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const NOW = 1_800_000_000;
const ORG = 'org-buyer';
const BUYER = `${CHAIN_IDS.SOLANA_DEVNET}:9B2yKCsMTQNbMjJU3wvwhKxjvtpA6TmmbeLtPV4Totpo`;
const PAYEE = `${CHAIN_IDS.SOLANA_DEVNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`;
const PROVIDER_ORG = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<RedeemableIntent> = {}): RedeemableIntent {
  return {
    organizationId: ORG,
    id: 'intent-1',
    agentAccount: BUYER,
    providerAccount: PAYEE,
    assetId: USDC,
    decimals: getAssetMetadata(USDC).decimals,
    priceAmount: '1000000',
    requestHash: 'cd'.repeat(32),
    voucherSeq: '1',
    voucherSignature: 'sig',
    voucherResourceHash: `sha256:${'ab'.repeat(32)}`,
    voucherIssuedAt: String(NOW - 10),
    voucherDelegate: null,
    expiresAt: new Date((NOW + 300) * 1000),
    holdId: randomUUID(),
    providerId: PROVIDER_ORG,
    providerAmount: '800000',
    platformFee: '200000',
    redemptionLastError: null,
    ...overrides,
  };
}

interface Options {
  readonly outcome?: RedeemOutcomeKind;
  readonly programError?: string | null;
  readonly chainState?: Record<string, unknown> | null;
  /** The live stake read: a boolean, or an Error to throw. Absent: the redeemer cannot read. */
  readonly belowMinimum?: boolean | Error;
  readonly blocklist?: ReturnType<typeof noBlocks>;
  /** Short of free stake only because of unplanned / dead-key slash records (M-2). */
  readonly unplannedShort?: boolean | Error;
}

function build(rows: RedeemableIntent[], options: Options = {}) {
  const calls: RedeemVoucherRequest[] = [];
  const redeemer: Record<string, unknown> = {
    maxBatchSize: 1,
    async redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome> {
      calls.push(request);
      return {
        kind: options.outcome ?? RedeemOutcomeKind.REDEEMED,
        signature: null,
        programError: options.programError ?? null,
      };
    },
    async redeemBatch() {
      return [];
    },
  };
  if (options.belowMinimum !== undefined) {
    const answer = options.belowMinimum;
    redeemer.providerBelowMinimumStake = jest.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
  }
  if (options.unplannedShort !== undefined) {
    const answer = options.unplannedShort;
    redeemer.providerShortOnlyByUnplannedSlashes = jest.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
  }
  const intents = {
    commitRedeemedHold: jest.fn().mockResolvedValue(undefined),
    releaseHold: jest.fn().mockResolvedValue(true),
  };
  const payments = {
    findAwaitingRedemption: jest.fn().mockResolvedValue(rows),
    recordRedemptionError: jest.fn().mockResolvedValue(undefined),
    lapseRedemption: jest.fn().mockResolvedValue(undefined),
    recordProviderBlocks: jest.fn().mockResolvedValue(undefined),
  };
  const service = new VoucherRedemptionService(
    payments as never,
    intents as never,
    redeemer as never,
    { emit: jest.fn() } as never,
    options.blocklist ?? noBlocks(),
    () => NOW * 1000,
    (options.chainState ?? null) as never,
  );
  return { service, calls, intents, payments, redeemer };
}

/** A live on-chain blocklist that knows exactly `blocked`, and a snapshot that may fail. */
function chainStateWith(blocked: readonly string[], snapshot: 'ok' | 'fails' = 'ok') {
  const isBlocked = (account: string | null | undefined) =>
    !!account && blocked.map((a) => a.toLowerCase()).includes(account.toLowerCase());
  return {
    assertActive: jest.fn(),
    holdReason: jest.fn(async (_door: unknown, parties: { role: string; account: string }[]) => {
      const hit = parties.find((party) => isBlocked(party.account));
      return hit ? `the ${hit.role.toLowerCase()} is blocked on chain` : null;
    }),
    blockedAccounts: jest.fn(async () => {
      if (snapshot === 'fails') throw new Error('rpc down');
      return blocked.map((a) => a.toLowerCase());
    }),
    isBlockedLive: jest.fn(async (account: string) => isBlocked(account)),
  };
}

describe('VoucherRedemptionService — a provider blocked on chain forfeits (M1)', () => {
  it('does not ask the payer-side hold about the payee', async () => {
    const chainState = chainStateWith([]);
    const { service } = build([row()], { chainState });

    await service.run(USDC);

    const roles = chainState.holdReason.mock.calls.flatMap(([, parties]) =>
      (parties as { role: string }[]).map((party) => party.role),
    );
    expect(roles).not.toContain('PAYEE');
  });

  it('forfeits when the snapshot read failed and a live read shows the payee blocked', async () => {
    const chainState = chainStateWith([PAYEE], 'fails');
    const { service, calls, intents, payments } = build([row()], { chainState });

    await service.run(USDC);

    expect(calls).toEqual([]);
    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      `${PROVIDER_FORFEIT_PREFIX}PayeeBlockedOnChain`,
    );
  });

  it('maps an AddressBlocked revert to a provider forfeit when only the payee is blocked', async () => {
    // The snapshot missed the block (it landed after the pass started), so the
    // send reverted. The contract does not say whose address.
    const chainState = chainStateWith([]);
    const { service, intents, payments } = build([row()], {
      chainState,
      outcome: RedeemOutcomeKind.RETRY,
      programError: 'AddressBlocked',
    });
    chainState.isBlockedLive.mockImplementation(async (account: string) => account === PAYEE);

    await service.run(USDC);

    // Recorded as provider-caused first, so a block lifted before the voucher
    // closes still ends in a forfeit, never an absorb.
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      'PayeeBlockedOnChain',
    );
    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying an AddressBlocked revert when the payer is the one blocked', async () => {
    const chainState = chainStateWith([]);
    const { service, intents, payments } = build([row()], {
      chainState,
      outcome: RedeemOutcomeKind.RETRY,
      programError: 'AddressBlocked',
    });
    chainState.isBlockedLive.mockImplementation(
      async (account: string) => account === BUYER || account === PAYEE,
    );

    await service.run(USDC);

    expect(payments.recordRedemptionError).toHaveBeenCalledWith(ORG, 'intent-1', 'AddressBlocked');
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('forfeits, not lapses, a voucher that expired while its payee block was recorded', async () => {
    // The block was lifted after the voucher's deadline; the recorded cause
    // still decides.
    const { service, intents } = build([row({ redemptionLastError: 'PayeeBlockedOnChain' })], {
      chainState: chainStateWith([]),
      outcome: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'VoucherExpired',
    });

    await service.run(USDC);

    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
  });
});

describe('VoucherRedemptionService — provider fault is read live at close time (M3)', () => {
  it('forfeits when the stake is below the minimum NOW, whatever the last retry recorded', async () => {
    const { service, intents, payments } = build(
      [row({ redemptionLastError: 'EscrowWindowLimitExceeded' })],
      {
        outcome: RedeemOutcomeKind.UNREDEEMABLE,
        programError: 'VoucherExpired',
        belowMinimum: true,
      },
    );

    await service.run(USDC);

    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    // Both causes are kept: the provider's, and the refusal that closed it (L5).
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      `${PROVIDER_FORFEIT_PREFIX}ProviderBelowMinimumStake (refused EscrowWindowLimitExceeded)`,
    );
  });

  it('asks the live stake before ANY lapse, not only after VoucherExpired', async () => {
    const { service, intents } = build([row()], {
      outcome: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'DelegateIsRevoked',
      belowMinimum: true,
    });

    await service.run(USDC);

    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
  });

  it('keeps the hold open when the stake cannot be read, inside the landing window', async () => {
    const { service, intents, payments } = build([row()], {
      outcome: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'VoucherExpired',
      belowMinimum: new Error('rpc down'),
    });

    await service.run(USDC);

    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
  });

  it('L4: a stake read still failing past the landing window is neutral — buyer debt', async () => {
    // Past `expiresAt + skew + grace + LANDING_SETTLE_SECONDS`.
    const { service, intents, payments } = build(
      [row({ expiresAt: new Date((NOW - 3 * 3600) * 1000) })],
      {
        outcome: RedeemOutcomeKind.UNREDEEMABLE,
        programError: 'VoucherExpired',
        belowMinimum: new Error('rpc down'),
      },
    );

    await service.run(USDC);

    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', 'VoucherExpired');
  });

  it('N3: VoucherExpired with no recorded cause and a clean provider is buyer debt', async () => {
    // A late verdict, an outage or a payer block lifted after the deadline.
    const { service, intents, payments } = build([row()], {
      outcome: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'VoucherExpired',
      belowMinimum: false,
    });

    await service.run(USDC);

    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', 'VoucherExpired');
  });

  it('N1/M1: a recorded ProviderBelowMinimumStake forfeits whatever the closing refusal is', async () => {
    // The provider unstaked (recorded), the buyer then revoked, and the
    // provider re-bonded: the chain answers DelegateIsRevoked, the live stake
    // reads fine — the recorded provider cause still decides.
    const { service, intents, payments } = build(
      [row({ redemptionLastError: 'ProviderBelowMinimumStake' })],
      {
        outcome: RedeemOutcomeKind.UNREDEEMABLE,
        programError: 'DelegateIsRevoked',
        belowMinimum: false,
      },
    );

    await service.run(USDC);

    expect(payments.lapseRedemption).not.toHaveBeenCalled();
    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      `${PROVIDER_FORFEIT_PREFIX}ProviderBelowMinimumStake`,
    );
  });

  it('M1: a stored provider_forfeit (release lost in a crash) forfeits again, never lapses', async () => {
    const { service, intents, payments } = build(
      [row({ redemptionLastError: `${PROVIDER_FORFEIT_PREFIX}PayeeBlocked` })],
      {
        outcome: RedeemOutcomeKind.UNREDEEMABLE,
        programError: 'VoucherExpired',
        belowMinimum: false,
      },
    );

    await service.run(USDC);

    expect(payments.lapseRedemption).not.toHaveBeenCalled();
    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
  });

  it('never lets a later refusal overwrite a recorded provider-caused one', async () => {
    // The provider dipped below its minimum while the voucher was live; a
    // later refusal from elsewhere must not turn the forfeit into an absorb
    // once the provider tops up again.
    const { service, payments } = build(
      [row({ redemptionLastError: 'ProviderBelowMinimumStake' })],
      {
        outcome: RedeemOutcomeKind.RETRY,
        programError: 'EscrowWindowLimitExceeded',
      },
    );

    await service.run(USDC);

    expect(payments.recordRedemptionError).not.toHaveBeenCalled();
  });
});

describe('VoucherRedemptionService — a blocked buyer freezes collection (L4)', () => {
  it('holds, not forfeits, a voucher whose payer AND provider are both blocked', async () => {
    const blocklist = noBlocks();
    addBlock(blocklist, { kind: BlockSubjectKind.WALLET, subject: BUYER });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: PROVIDER_ORG });
    const { service, calls, intents } = build([row()], { blocklist });

    await service.run(USDC);

    expect(calls).toEqual([]);
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('M2: records the provider block while held, so the close after both unblocks forfeits', async () => {
    const blocklist = noBlocks();
    addBlock(blocklist, { kind: BlockSubjectKind.WALLET, subject: BUYER });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: PROVIDER_ORG });
    const pass1 = build([row()], { blocklist });

    await pass1.service.run(USDC);

    expect(pass1.calls).toEqual([]);
    expect(pass1.intents.releaseHold).not.toHaveBeenCalled();
    expect(pass1.payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      'ProviderBlocked',
    );
    // ...and the whole queue gets the same sticky cause, frozen rows included.
    expect(pass1.payments.recordProviderBlocks).toHaveBeenCalled();

    // Both blocks lifted after the deadline: the recorded cause decides.
    const pass2 = build([row({ redemptionLastError: 'ProviderBlocked' })], {
      outcome: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'VoucherExpired',
      belowMinimum: false,
    });
    await pass2.service.run(USDC);

    expect(pass2.payments.lapseRedemption).not.toHaveBeenCalled();
    expect(pass2.intents.releaseHold).toHaveBeenCalledTimes(1);
  });
});

/**
 * Review 2026-10-24 wave 2 M-2: a provider below its minimum free stake only
 * because of slash records it did not cause (records this platform never
 * planned, or signed by a revoked verifier key) is not at fault. Its vouchers
 * are retried until their deadline, the refusal is not sticky, and only a
 * voucher that dies of it is forfeited — under its own cause.
 */
describe('VoucherRedemptionService — a shortfall from unplanned slash records (M-2)', () => {
  const UNPLANNED = 'ProviderStakeHeldByUnplannedSlash';

  it('records the refusal under its own, non-sticky name and keeps retrying', async () => {
    const { service, payments, intents } = build([row()], {
      outcome: RedeemOutcomeKind.RETRY,
      programError: 'ProviderBelowMinimumStake',
      unplannedShort: true,
    });

    await service.run(USDC);

    expect(payments.recordRedemptionError).toHaveBeenCalledWith(ORG, 'intent-1', UNPLANNED);
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
  });

  it('a later refusal replaces it: it is not the provider’s fault', async () => {
    const { service, payments } = build([row({ redemptionLastError: UNPLANNED })], {
      outcome: RedeemOutcomeKind.RETRY,
      programError: 'EscrowWindowLimitExceeded',
      unplannedShort: true,
    });

    await service.run(USDC);

    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      'EscrowWindowLimitExceeded',
    );
  });

  it('a buyer-caused close after it is not turned into the provider’s forfeit', async () => {
    // The reaper released the records; the buyer then revoked its delegate.
    const { service, payments, intents } = build([row({ redemptionLastError: UNPLANNED })], {
      outcome: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'DelegateIsRevoked',
      belowMinimum: false,
    });

    await service.run(USDC);

    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', 'DelegateIsRevoked');
  });

  it('a voucher that dies of it at its deadline is forfeited under that cause, never buyer debt', async () => {
    const { service, payments, intents } = build([row({ redemptionLastError: UNPLANNED })], {
      outcome: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'VoucherExpired',
      // Released since: the live read says fine. It still died of the shortfall.
      belowMinimum: false,
    });

    await service.run(USDC);

    expect(payments.lapseRedemption).not.toHaveBeenCalled();
    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      `${PROVIDER_FORFEIT_PREFIX}${UNPLANNED}`,
    );
  });

  it('names the shortfall, not the provider’s minimum, when a live read decides a close', async () => {
    const { service, payments } = build([row()], {
      outcome: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'VoucherExpired',
      belowMinimum: true,
      unplannedShort: true,
    });

    await service.run(USDC);

    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      `${PROVIDER_FORFEIT_PREFIX}${UNPLANNED} (refused VoucherExpired)`,
    );
  });

  it('a provider below its minimum for its own reasons is unchanged: sticky, provider-caused', async () => {
    const { service, payments } = build([row()], {
      outcome: RedeemOutcomeKind.RETRY,
      programError: 'ProviderBelowMinimumStake',
      unplannedShort: false,
    });

    await service.run(USDC);

    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      'ProviderBelowMinimumStake',
    );
  });

  it('an unreadable attribution falls back to the provider’s fault, as before', async () => {
    const { service, payments } = build([row()], {
      outcome: RedeemOutcomeKind.RETRY,
      programError: 'ProviderBelowMinimumStake',
      unplannedShort: new Error('rpc down'),
    });

    await service.run(USDC);

    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      'ProviderBelowMinimumStake',
    );
  });
});
