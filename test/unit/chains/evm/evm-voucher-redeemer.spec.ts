import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  toFunctionSelector,
} from 'viem';

import { X402_ESCROW_ABI } from '@modules/chains/evm/abi/x402.abi';
import { EvmReaderClient } from '@modules/chains/evm/evm-escrow-balance-reader.service';
import {
  EVM_REDEEM_BATCH_BASE_GAS,
  EVM_REDEEM_PER_VOUCHER_GAS,
  EvmVoucherRedeemer,
} from '@modules/chains/evm/evm-voucher-redeemer.service';
import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';
import {
  EvmRelayedCall,
  EvmRelayResult,
  EvmRelayerPort,
  EvmValueTransfer,
} from '@modules/chains/evm/ports/evm-relayer.port';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import {
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { Alert, AlertPort } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import { deployment } from './evm-fixtures';

/**
 * `EvmVoucherRedeemer` — pre-validate the batch, and retry singly.
 *
 * `redeemVoucherBatch` is atomic: one bad voucher reverts all 64. So there are
 * exactly two obligations, both stated in the imperative in assay-evm's
 * `docs/gas.md`, and both unenforceable on chain —
 * every assertion below is about one of them.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const DEPLOYMENT = deployment(TESTNET);
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;

/** The redeemer key's address — `Config.params().redeemer`. */
const REDEEMER = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const PROVIDER = '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2';
const NOW = 1_800_000_000;

/** Distinct payers, so a batch may hold one of each. */
function payerAddress(index: number): `0x${string}` {
  return getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`);
}

const HEALTHY_ESCROW = {
  balance: 5_000_000n,
  seqHigh: 0n,
  authNonce: 0n,
  maxVoucherAmount: 2_000_000n,
  maxPerWindow: 10_000_000n,
  spentInWindow: 0n,
  windowStartedAt: BigInt(NOW - 3_600),
  withdrawRequested: 0n,
  withdrawAvailableAt: 0n,
  totalRedeemed: 0n,
  totalWithdrawn: 0n,
  totalFunded: 5_000_000n,
};

const PARAMS = {
  treasury: '0x000000000000000000000000000000000000dEaD',
  redeemer: REDEEMER,
  unbondingPeriodSeconds: 1_209_600n,
  minimumStake: 50_000_000n,
  penaltyAmount: 1_000_000n,
  verifierDailyCap: 100_000_000n,
  takeRateBps: 1_200,
  slashAgentBps: 5_000,
  slashPlatformBps: 3_000,
  slashCapBps: 2_000,
};

function request(
  index: number,
  overrides: Partial<RedeemVoucherRequest> = {},
): RedeemVoucherRequest {
  return {
    payer: toAccountId(TESTNET, payerAddress(index)),
    provider: toAccountId(TESTNET, PROVIDER),
    amount: MoneyUtil.of('1000000', USDG, 6),
    asset: USDG,
    resourceHash: `sha256:${'ab'.repeat(32)}`,
    requestHash: 'cd'.repeat(32),
    seq: '10',
    issuedAt: NOW - 10,
    expiresAt: NOW + 60,
    signature: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`,
    ...overrides,
  };
}

interface ChainState {
  paused: boolean;
  redeemer: string;
  minimumStake: bigint;
  bonded: bigint;
  /** Per payer ADDRESS (lower case). Anything absent uses `HEALTHY_ESCROW`. */
  escrows: Record<string, Record<string, bigint>>;
  /** `payer:delegate` (lower case) → the delegate's grant. */
  delegations: Record<string, Record<string, unknown>>;
  /** What an `eth_call` of the redemption answers: null = it would settle. */
  simulateRevert: string | null;
  /** Every simulated function, in order. */
  simulated: string[];
  /** The `account` (msg.sender) every simulation was run from, in order. */
  simulatedFrom: string[];
  /** The `eth_call` itself fails (an outage, no revert data). */
  simulateOutage: boolean;
}

function harness(overrides: Partial<ChainState> = {}) {
  const state: ChainState = {
    paused: false,
    redeemer: REDEEMER,
    minimumStake: 50_000_000n,
    bonded: 50_000_000n,
    escrows: {},
    delegations: {},
    simulateRevert: null,
    simulated: [],
    simulatedFrom: [],
    simulateOutage: false,
    ...overrides,
  };

  const answer = (functionName: string, args: readonly unknown[]): unknown => {
    switch (functionName) {
      case 'params':
        return { ...PARAMS, redeemer: state.redeemer, minimumStake: state.minimumStake };
      case 'paused':
        return state.paused;
      case 'escrowOf': {
        const key = String(args[0]).toLowerCase();
        return { ...HEALTHY_ESCROW, ...(state.escrows[key] ?? {}) };
      }
      case 'bondedOf':
        return state.bonded;
      case 'delegationOf': {
        const key = `${String(args[0]).toLowerCase()}:${String(args[1]).toLowerCase()}`;
        return {
          maxVoucherAmount: 0n,
          maxPerWindow: 0n,
          spentInWindow: 0n,
          windowStartedAt: 0n,
          validUntil: 0n,
          listPosition: 0,
          revoked: false,
          ...(state.delegations[key] ?? {}),
        };
      }
      case 'redeemVoucher':
      case 'redeemVoucherBatch':
        state.simulated.push(functionName);
        if (state.simulateOutage) throw new Error('fetch failed');
        if (state.simulateRevert !== null) {
          throw Object.assign(new Error('execution reverted'), {
            data: toFunctionSelector(`${state.simulateRevert}()`),
          });
        }
        return undefined;
      default:
        throw new Error(`unexpected read of ${functionName}`);
    }
  };

  const client: EvmReaderClient = {
    readContract: async (args) => {
      const from = (args as { account?: string }).account;
      if (from !== undefined) state.simulatedFrom.push(from);
      return answer(args.functionName, args.args);
    },
    multicall: async (args) => args.contracts.map((c) => answer(c.functionName, c.args)),
  };

  const sendCall = jest.fn<Promise<EvmRelayResult>, [EvmRelayedCall]>().mockResolvedValue({
    hash: '0xfeed',
    status: 'SUCCESS',
    revertReason: null,
    gasUsed: 100_000n,
    blockNumber: 1n,
  });

  const redeemerPort: EvmRelayerPort = {
    name: 'fake-redeemer',
    address: async () => toAccountId(TESTNET, REDEEMER),
    balanceWei: async () => 10n ** 18n,
    sendCall,
    sendValue: async (_transfer: EvmValueTransfer) => {
      throw new Error('the redeemer must never send value');
    },
  };

  const emitted: Alert[] = [];
  const alerts: AlertPort = {
    emit: async (alert: Alert) => {
      emitted.push(alert);
    },
  } as unknown as AlertPort;

  const redeemer = new EvmVoucherRedeemer(
    new Map<ChainId, EvmReaderClient>([[TESTNET, client]]),
    new Map([[TESTNET, DEPLOYMENT]]),
    redeemerPort,
    alerts,
    { now: () => NOW * 1000 },
  );

  return { redeemer, sendCall, emitted, state };
}

function calledFunction(call: EvmRelayedCall): string {
  return decodeFunctionData({ abi: X402_ESCROW_ABI, data: call.data }).functionName;
}

function batchedPayers(call: EvmRelayedCall): string[] {
  const decoded = decodeFunctionData({ abi: X402_ESCROW_ABI, data: call.data });
  const vouchers = decoded.args?.[0] as readonly { payer: string }[];
  return vouchers.map((v) => v.payer.toLowerCase());
}

describe('EvmVoucherRedeemer', () => {
  it('takes 64 in one transaction, and says so', () => {
    const { redeemer } = harness();
    expect(redeemer.maxBatchSize).toBe(64);
    expect(redeemer.maxBatchSize).toBe(EVM_CONSTANTS.MAX_REDEEM_BATCH);
  });

  it('redeems a single voucher through redeemVoucher, not the batch entry point', async () => {
    const { redeemer, sendCall } = harness();

    const outcome = await redeemer.redeem(request(0));

    expect(outcome.kind).toBe(RedeemOutcomeKind.REDEEMED);
    expect(outcome.signature).toBe('0xfeed');
    expect(sendCall).toHaveBeenCalledTimes(1);
    expect(calledFunction(sendCall.mock.calls[0][0])).toBe('redeemVoucher');
  });

  it('batches many through redeemVoucherBatch, in the order it was handed', async () => {
    const { redeemer, sendCall } = harness();

    const outcomes = await redeemer.redeemBatch([request(0), request(1), request(2)]);

    expect(outcomes.map((o) => o.kind)).toEqual(['REDEEMED', 'REDEEMED', 'REDEEMED']);
    expect(sendCall).toHaveBeenCalledTimes(1);
    expect(calledFunction(sendCall.mock.calls[0][0])).toBe('redeemVoucherBatch');
    expect(batchedPayers(sendCall.mock.calls[0][0])).toEqual([
      payerAddress(0).toLowerCase(),
      payerAddress(1).toLowerCase(),
      payerAddress(2).toLowerCase(),
    ]);
  });

  it('never submits a voucher pre-validation refused, and still reports it', async () => {
    // Payer 1's escrow has already redeemed seq 10, so their voucher is stale.
    // Submitting it would revert the batch and take two good ones with it.
    const { redeemer, sendCall } = harness({
      escrows: { [payerAddress(1).toLowerCase()]: { seqHigh: 10n } },
    });

    const outcomes = await redeemer.redeemBatch([request(0), request(1), request(2)]);

    expect(batchedPayers(sendCall.mock.calls[0][0])).toEqual([
      payerAddress(0).toLowerCase(),
      payerAddress(2).toLowerCase(),
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual(['REDEEMED', 'UNREDEEMABLE', 'REDEEMED']);
    expect(outcomes[1].programError).toBe('VoucherSeqNotIncreasing');
    expect(outcomes[1].signature).toBeNull();
  });

  it('sends nothing at all when pre-validation refuses every item', async () => {
    const { redeemer, sendCall } = harness({ minimumStake: 60_000_000n });

    const outcomes = await redeemer.redeemBatch([request(0), request(1)]);

    expect(sendCall).not.toHaveBeenCalled();
    expect(outcomes.map((o) => o.programError)).toEqual([
      'ProviderBelowMinimumStake',
      'ProviderBelowMinimumStake',
    ]);
    // Retryable: the provider can top their stake back up.
    expect(outcomes.map((o) => o.kind)).toEqual(['RETRY', 'RETRY']);
  });

  it('reads the provider stake against the minimum live (review M3)', async () => {
    const below = harness({ minimumStake: 60_000_000n });
    await expect(below.redeemer.providerBelowMinimumStake(request(0))).resolves.toBe(true);

    const fine = harness();
    await expect(fine.redeemer.providerBelowMinimumStake(request(0))).resolves.toBe(false);
  });

  it('retries SINGLY when the batch reverts, and never re-submits the batch', async () => {
    const { redeemer, sendCall } = harness();
    sendCall.mockResolvedValueOnce({
      hash: '0xbad',
      status: 'REVERTED',
      revertReason: 'EscrowInsufficient',
      gasUsed: 10n,
      blockNumber: 1n,
    });

    await redeemer.redeemBatch([request(0), request(1), request(2)]);

    // One batch attempt, then three singles. A fourth batch call is the bug
    // this test exists for: it reverts identically, for ever.
    expect(sendCall).toHaveBeenCalledTimes(4);
    expect(calledFunction(sendCall.mock.calls[0][0])).toBe('redeemVoucherBatch');
    for (const [call] of sendCall.mock.calls.slice(1)) {
      expect(calledFunction(call)).toBe('redeemVoucher');
    }
  });

  it('reports each single retry on its OWN item, not the batch verdict', async () => {
    // The failure this catches: marking all three UNREDEEMABLE (or all three
    // RETRY) because the batch said EscrowInsufficient, when only one of them
    // was short.
    const { redeemer, sendCall } = harness();
    const reverted = (reason: string): EvmRelayResult => ({
      hash: '0xbad',
      status: 'REVERTED',
      revertReason: reason,
      gasUsed: 10n,
      blockNumber: 1n,
    });
    const ok = (hash: string): EvmRelayResult => ({
      hash,
      status: 'SUCCESS',
      revertReason: null,
      gasUsed: 10n,
      blockNumber: 1n,
    });

    sendCall
      .mockResolvedValueOnce(reverted('EscrowInsufficient'))
      .mockResolvedValueOnce(ok('0xa'))
      .mockResolvedValueOnce(reverted('EscrowInsufficient'))
      .mockResolvedValueOnce(ok('0xc'));

    const outcomes = await redeemer.redeemBatch([request(0), request(1), request(2)]);

    expect(outcomes.map((o) => o.kind)).toEqual(['REDEEMED', 'RETRY', 'REDEEMED']);
    expect(outcomes.map((o) => o.signature)).toEqual(['0xa', null, '0xc']);
  });

  it('keeps a pre-validation refusal on its own row through a batch revert', async () => {
    // The refused item is not in the batch and must not be in the retry either
    // — its outcome came from the pre-validation and is still the right one.
    const { redeemer, sendCall } = harness({
      escrows: { [payerAddress(1).toLowerCase()]: { seqHigh: 10n } },
    });
    sendCall.mockResolvedValueOnce({
      hash: '0xbad',
      status: 'REVERTED',
      revertReason: 'EscrowInsufficient',
      gasUsed: 10n,
      blockNumber: 1n,
    });

    const outcomes = await redeemer.redeemBatch([request(0), request(1), request(2)]);

    // 1 batch + 2 singles. The refused one was never sent, twice over.
    expect(sendCall).toHaveBeenCalledTimes(3);
    expect(outcomes[1].kind).toBe(RedeemOutcomeKind.UNREDEEMABLE);
    expect(outcomes[1].programError).toBe('VoucherSeqNotIncreasing');
  });

  it('refuses two vouchers from the SAME payer in one batch', async () => {
    // `seq` is per payer: the second copy would fail `seq > seqHigh` because
    // the first already advanced it, and take the whole batch with it.
    const { redeemer } = harness();

    await expect(redeemer.redeemBatch([request(0), request(0, { seq: '11' })])).rejects.toThrow(
      /payer/i,
    );
  });

  it('refuses a batch of 65 and accepts a batch of 64', async () => {
    const { redeemer } = harness();
    const sixtyFour = Array.from({ length: 64 }, (_, i) => request(i));

    await expect(redeemer.redeemBatch([...sixtyFour, request(64)])).rejects.toThrow(/64/);
    await expect(redeemer.redeemBatch(sixtyFour)).resolves.toHaveLength(64);
  });

  it('an unknown revert is RETRY, never UNREDEEMABLE, and it alerts', async () => {
    // Absorbing a hold because the reason could not be read charges a buyer for
    // nothing. The alert is the other half.
    const { redeemer, sendCall, emitted } = harness();
    sendCall.mockResolvedValue({
      hash: '0xbad',
      status: 'REVERTED',
      revertReason: 'UNKNOWN_REVERT:0xdeadbeef',
      gasUsed: 10n,
      blockNumber: 1n,
    });

    const [outcome] = await redeemer.redeemBatch([request(0)]);

    expect(outcome.kind).toBe(RedeemOutcomeKind.RETRY);
    expect(outcome.programError).toBe('UNKNOWN_REVERT:0xdeadbeef');
    expect(emitted.length).toBeGreaterThan(0);
  });

  it.each([
    ['ProgramPaused', RedeemOutcomeKind.PAUSED],
    ['NotRedeemer', RedeemOutcomeKind.MISCONFIGURED],
    ['AssetDecimalsNotSix', RedeemOutcomeKind.MISCONFIGURED],
    ['VoucherSeqNotIncreasing', RedeemOutcomeKind.UNREDEEMABLE],
    ['SignerIsNotPayer', RedeemOutcomeKind.UNREDEEMABLE],
    ['MalleableSignature', RedeemOutcomeKind.UNREDEEMABLE],
    ['VoucherSeqGapTooLarge', RedeemOutcomeKind.UNREDEEMABLE],
    ['DelegateWindowLimitExceeded', RedeemOutcomeKind.RETRY],
    // A re-grant or a raised cap before the deadline revives the same voucher,
    // so these are retried until then (review-buyer-debt M3).
    ['DelegateVoucherExceedsPerCallLimit', RedeemOutcomeKind.RETRY],
    ['DelegateIsRevoked', RedeemOutcomeKind.RETRY],
    ['DelegateIsExpired', RedeemOutcomeKind.RETRY],
    ['EscrowInsufficient', RedeemOutcomeKind.RETRY],
    ['VoucherNotYetValid', RedeemOutcomeKind.RETRY],
    ['ProviderBelowMinimumStake', RedeemOutcomeKind.RETRY],
  ])('maps the revert %s to %s', async (reason, kind) => {
    const { redeemer, sendCall } = harness();
    sendCall.mockResolvedValue({
      hash: '0xbad',
      status: 'REVERTED',
      revertReason: reason,
      gasUsed: 10n,
      blockNumber: 1n,
    });

    const outcome = await redeemer.redeem(request(0));

    expect(outcome.kind).toBe(kind);
    expect(outcome.programError).toBe(reason);
    expect(outcome.signature).toBeNull();
  });

  it('refuses a seq more than MAX_SEQ_GAP above seqHigh before simulating or sending', async () => {
    const seqHigh = 5n;
    const gap = BigInt(EVM_CONSTANTS.MAX_SEQ_GAP);
    const { redeemer, sendCall, state } = harness({
      escrows: { [payerAddress(0).toLowerCase()]: { seqHigh } },
    });

    const refused = await redeemer.redeem(request(0, { seq: (seqHigh + gap + 1n).toString() }));

    expect(refused).toMatchObject({
      kind: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'VoucherSeqGapTooLarge',
    });
    expect(state.simulated).toEqual([]);
    expect(sendCall).not.toHaveBeenCalled();

    // Exactly the gap is the chain's own boundary, and settles.
    const accepted = await redeemer.redeem(request(0, { seq: (seqHigh + gap).toString() }));
    expect(accepted.kind).toBe(RedeemOutcomeKind.REDEEMED);
  });

  it('reports PAUSED without sending, when the chain says paused', async () => {
    const { redeemer, sendCall } = harness({ paused: true });

    const outcome = await redeemer.redeem(request(0));

    expect(outcome.kind).toBe(RedeemOutcomeKind.PAUSED);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('reports MISCONFIGURED without sending, when its key is not the configured redeemer', async () => {
    // `msg.sender != p.redeemer` refuses EVERY hold identically until an admin
    // acts. Retrying would burn a fee per hold per pass for ever; absorbing
    // would hand every buyer their money back for a one-transaction fix.
    const { redeemer, sendCall } = harness({ redeemer: PROVIDER });

    const outcome = await redeemer.redeem(request(0));

    expect(outcome.kind).toBe(RedeemOutcomeKind.MISCONFIGURED);
    expect(outcome.programError).toBe('NotRedeemer');
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('sends to the escrow contract, never to the payer or the stake contract', async () => {
    const { redeemer, sendCall } = harness();

    await redeemer.redeem(request(0));

    expect(sendCall.mock.calls[0][0].to).toBe(toAccountId(TESTNET, DEPLOYMENT.escrow));
  });

  it('budgets gas that stays well under the chain transaction ceiling at 64', async () => {
    // `ArbGasInfo.getGasAccountingParams()` → `maxTxGasLimit = 32,000,000` on
    // both 4663 and 46630. A budget that exceeded it would be a batch the node
    // refuses outright, which is not a revert and carries no reason.
    const { redeemer, sendCall } = harness();
    await redeemer.redeemBatch(Array.from({ length: 64 }, (_, i) => request(i)));

    const gas = sendCall.mock.calls[0][0].gasLimit;
    expect(gas).toBe(EVM_REDEEM_BATCH_BASE_GAS + EVM_REDEEM_PER_VOUCHER_GAS * 64n);
    expect(gas).toBeLessThan(32_000_000n);
    // And above the worst measured batch of 64 (5,235,730), or the batch runs
    // out of gas having spent it.
    expect(gas).toBeGreaterThan(5_235_730n);
  });

  it('refuses a batch that spans two chains', async () => {
    const { redeemer } = harness();

    await expect(
      redeemer.redeemBatch([
        request(0),
        request(1, { payer: `${CHAIN_IDS.BASE_SEPOLIA}:${payerAddress(1)}` as AccountId }),
      ]),
    ).rejects.toThrow();
  });

  it('answers an empty batch with an empty array and no transaction', async () => {
    const { redeemer, sendCall } = harness();

    await expect(redeemer.redeemBatch([])).resolves.toEqual([]);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('carries the signed voucher fields onto the wire unchanged', async () => {
    const { redeemer, sendCall } = harness();

    await redeemer.redeem(request(0, { seq: '10', amount: MoneyUtil.of('1000000', USDG, 6) }));

    const decoded = decodeFunctionData({
      abi: X402_ESCROW_ABI,
      data: sendCall.mock.calls[0][0].data,
    });
    const voucher = decoded.args?.[0] as Record<string, unknown>;
    expect(voucher).toEqual({
      payer: payerAddress(0),
      provider: getAddress(PROVIDER),
      amount: 1_000_000n,
      // `sha256:` is this codebase's prefix, not a chain value — the contract
      // signs 32 raw bytes.
      resourceHash: `0x${'ab'.repeat(32)}`,
      requestHash: `0x${'cd'.repeat(32)}`,
      seq: 10n,
      issuedAt: BigInt(NOW - 10),
      expiresAt: BigInt(NOW + 60),
    });
    expect(decoded.args?.[1]).toBe(`0x${'11'.repeat(32)}${'22'.repeat(32)}1b`);
  });

  it('accepts the requestHash exactly as a platform-recorded intent carries it', async () => {
    // `VoucherService.record` stores `voucher.requestHash` verbatim, and on this
    // platform that is `computeRequestHash`'s `sha256:<64 hex>`.
    // `VoucherRedemptionService` replays that column unchanged, so a redeemer
    // that accepted only bare hex refused EVERY voucher the platform itself had
    // recorded — `yarn testnet:e2` never saw it because it passed bare hex.
    const { redeemer, sendCall } = harness();

    await redeemer.redeem(request(0, { requestHash: `sha256:${'cd'.repeat(32)}` }));

    const decoded = decodeFunctionData({
      abi: X402_ESCROW_ABI,
      data: sendCall.mock.calls[0][0].data,
    });
    expect((decoded.args?.[0] as Record<string, unknown>).requestHash).toBe(`0x${'cd'.repeat(32)}`);
  });

  it('refuses a signature that is not a 65-byte secp256k1 tuple', async () => {
    const { redeemer } = harness();

    await expect(redeemer.redeem(request(0, { signature: 'not-hex' }))).rejects.toThrow(
      /signature/i,
    );
  });

  // ── Review S2-2: nothing the chain would refuse is ever broadcast ─────────

  describe('simulates before every broadcast', () => {
    it('does not broadcast a batch the chain would refuse; it goes to the singles, which simulate too', async () => {
      const { redeemer, sendCall, state } = harness({ simulateRevert: 'SignerIsNotPayer' });
      const outcomes = await redeemer.redeemBatch([request(0), request(1)]);
      expect(sendCall).not.toHaveBeenCalled();
      expect(state.simulated).toEqual(['redeemVoucherBatch', 'redeemVoucher', 'redeemVoucher']);
      expect(outcomes.map((o) => o.kind)).toEqual([
        RedeemOutcomeKind.UNREDEEMABLE,
        RedeemOutcomeKind.UNREDEEMABLE,
      ]);
    });

    it('does not broadcast a single redemption the chain would refuse', async () => {
      const { redeemer, sendCall } = harness({ simulateRevert: 'DelegateIsRevoked' });
      const outcome = await redeemer.redeem(request(0));
      expect(sendCall).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        kind: RedeemOutcomeKind.RETRY,
        programError: 'DelegateIsRevoked',
      });
    });

    it('simulates with the redeemer as sender and the gas it will send', async () => {
      const { redeemer, sendCall, state } = harness();
      await redeemer.redeem(request(0));
      expect(state.simulated).toEqual(['redeemVoucher']);
      // `msg.sender` of the simulation is the REDEEMER port's account — the
      // key that will send — never some other relayer.
      expect(state.simulatedFrom).toEqual([REDEEMER]);
      expect(sendCall).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when the simulation cannot be answered (an outage, not a revert)', async () => {
      const { redeemer, sendCall } = harness({ simulateOutage: true });
      await expect(redeemer.redeem(request(0))).rejects.toThrow('fetch failed');
      expect(sendCall).not.toHaveBeenCalled();
    });
  });

  describe('pre-validates a delegate-signed voucher against the delegate’s grant', () => {
    const DELEGATE = '0x5555555555555555555555555555555555555555';
    const grantKey = (index: number) => `${payerAddress(index).toLowerCase()}:${DELEGATE}`;
    const live = {
      maxVoucherAmount: 2_000_000n,
      maxPerWindow: 5_000_000n,
      validUntil: BigInt(NOW + 3600),
      listPosition: 1,
    };

    it.each([
      ['revoked', { ...live, revoked: true }, 'DelegateIsRevoked', RedeemOutcomeKind.RETRY],
      [
        'lapsed',
        { ...live, validUntil: BigInt(NOW - 1) },
        'DelegateIsExpired',
        RedeemOutcomeKind.RETRY,
      ],
      ['never authorised', { validUntil: 0n }, 'SignerIsNotPayer', RedeemOutcomeKind.UNREDEEMABLE],
      [
        'over its per-voucher cap',
        { ...live, maxVoucherAmount: 999_999n },
        'DelegateVoucherExceedsPerCallLimit',
        RedeemOutcomeKind.RETRY,
      ],
      [
        'over its window',
        { ...live, spentInWindow: 4_500_000n, windowStartedAt: BigInt(NOW) },
        'DelegateWindowLimitExceeded',
        RedeemOutcomeKind.RETRY,
      ],
    ])('a %s delegate is refused before anything is sent', async (_name, grant, error, kind) => {
      const { redeemer, sendCall, state } = harness();
      state.delegations[grantKey(0)] = grant;
      const outcome = await redeemer.redeem(
        request(0, { delegate: toAccountId(TESTNET, getAddress(DELEGATE)) }),
      );
      expect(outcome).toMatchObject({ kind, programError: error });
      expect(sendCall).not.toHaveBeenCalled();
      expect(state.simulated).toEqual([]);
    });

    it('batches a live delegate’s voucher, and keeps a revoked one out of the batch', async () => {
      const { redeemer, sendCall, state } = harness();
      state.delegations[grantKey(0)] = live;
      state.delegations[grantKey(1)] = { ...live, revoked: true };
      const outcomes = await redeemer.redeemBatch([
        request(0, { delegate: toAccountId(TESTNET, getAddress(DELEGATE)) }),
        request(1, { delegate: toAccountId(TESTNET, getAddress(DELEGATE)) }),
        request(2),
      ]);
      expect(sendCall).toHaveBeenCalledTimes(1);
      const call = sendCall.mock.calls[0][0];
      const decoded = decodeFunctionData({ abi: X402_ESCROW_ABI, data: call.data });
      expect((decoded.args as unknown as unknown[][])[0]).toHaveLength(2);
      expect(outcomes.map((o) => o.kind)).toEqual([
        RedeemOutcomeKind.REDEEMED,
        RedeemOutcomeKind.RETRY,
        RedeemOutcomeKind.REDEEMED,
      ]);
    });
  });

  /**
   * REGRESSION (review 2026-10-15 P-1): `VoucherSeqNotIncreasing` is also what
   * a voucher that already landed gets. The redeemer records each transaction
   * before its broadcast, and can say afterwards whether one of them redeemed
   * this voucher — so the job commits it instead of absorbing it.
   */
  describe('a landing this process did not observe', () => {
    it('records the transaction on the voucher before it is broadcast', async () => {
      const { redeemer, sendCall } = harness();
      const recordAttempt = jest.fn().mockResolvedValue(undefined);
      await redeemer.redeem(request(0, { recordAttempt }));
      const call = sendCall.mock.calls[0][0];
      expect(recordAttempt).not.toHaveBeenCalled();
      await call.beforeBroadcast?.(`0x${'aa'.repeat(32)}`);
      expect(recordAttempt).toHaveBeenCalledWith(`0x${'aa'.repeat(32)}`);
    });

    it('records one batch transaction on every voucher it carries', async () => {
      const { redeemer, sendCall } = harness();
      const first = jest.fn().mockResolvedValue(undefined);
      const second = jest.fn().mockResolvedValue(undefined);
      await redeemer.redeemBatch([
        request(0, { recordAttempt: first }),
        request(1, { recordAttempt: second }),
      ]);
      await sendCall.mock.calls[0][0].beforeBroadcast?.(`0x${'bb'.repeat(32)}`);
      expect(first).toHaveBeenCalledWith(`0x${'bb'.repeat(32)}`);
      expect(second).toHaveBeenCalledWith(`0x${'bb'.repeat(32)}`);
    });

    const LANDED = `0x${'01'.repeat(32)}` as const;
    const REVERTED = `0x${'02'.repeat(32)}` as const;
    const PENDING = `0x${'03'.repeat(32)}` as const;
    const DROPPED = `0x${'04'.repeat(32)}` as const;

    function redeemedLog(payer: `0x${string}`, seq: bigint, requestHash: `0x${string}`) {
      return {
        address: DEPLOYMENT.escrow,
        topics: encodeEventTopics({
          abi: X402_ESCROW_ABI,
          eventName: 'VoucherRedeemed',
          args: { payer, provider: getAddress(PROVIDER) },
        }) as [`0x${string}`, ...`0x${string}`[]],
        data: encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'uint64' },
            { type: 'uint64' },
            { type: 'uint64' },
            { type: 'uint16' },
            { type: 'uint64' },
          ],
          [requestHash, `0x${'ab'.repeat(32)}`, 1_000_000n, 120_000n, seq, 1_200, 0n],
        ),
      };
    }

    function chainWith(logsFor: (hash: string) => ReturnType<typeof redeemedLog>[]) {
      const notFound = (name: string) => Object.assign(new Error('could not be found'), { name });
      const client = {
        readContract: async () => undefined,
        multicall: async () => [],
        getTransactionReceipt: async ({ hash }: { hash: string }) => {
          if (hash === PENDING || hash === DROPPED) {
            throw notFound('TransactionReceiptNotFoundError');
          }
          return { status: hash === REVERTED ? 'reverted' : 'success', logs: logsFor(hash) };
        },
        getTransaction: async ({ hash }: { hash: string }) => {
          if (hash === DROPPED) throw notFound('TransactionNotFoundError');
          return {};
        },
      };
      return new EvmVoucherRedeemer(
        new Map([[TESTNET, client as unknown as EvmReaderClient]]),
        new Map([[TESTNET, DEPLOYMENT]]),
        {} as EvmRelayerPort,
        { emit: async () => undefined } as unknown as AlertPort,
        { now: () => NOW * 1000 },
      );
    }

    const requestHash = `0x${'cd'.repeat(32)}` as const;

    it('names the mined transaction that emitted VoucherRedeemed for this payer and seq', async () => {
      const redeemer = chainWith((hash) =>
        hash === LANDED ? [redeemedLog(payerAddress(0), 10n, requestHash)] : [],
      );
      await expect(redeemer.findLanding(request(0), [DROPPED, REVERTED, LANDED])).resolves.toBe(
        LANDED,
      );
    });

    it('answers null when no recorded transaction redeemed this voucher', async () => {
      // A landed transaction for ANOTHER seq, and one for another payer, are not this one.
      const redeemer = chainWith(() => [
        redeemedLog(payerAddress(0), 11n, requestHash),
        redeemedLog(payerAddress(1), 10n, requestHash),
      ]);
      await expect(redeemer.findLanding(request(0), [LANDED, REVERTED, DROPPED])).resolves.toBe(
        null,
      );
    });

    it('cannot tell while a recorded transaction is still pending', async () => {
      const redeemer = chainWith(() => []);
      await expect(redeemer.findLanding(request(0), [PENDING])).rejects.toThrow(/pending/);
    });
  });
});
