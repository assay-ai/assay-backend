import { randomUUID } from 'node:crypto';

import { getAddress } from 'viem';

import { VoucherChannelStatus } from '@database/postgres/entities/voucher-channel.entity';
import { VoucherAuthorityKind } from '@modules/chains/ports/voucher-authority.types';
import { DEFAULT_CHANNEL_POLICY } from '@modules/payment/domain/channel/channel-policy';
import { channelKeyOf, EMPTY_SLOT } from '@modules/payment/domain/channel/channel-voucher';
import { ChainErrors } from '@modules/chains/errors/chains.errors';
import { ChannelErrorCode } from '@modules/payment/errors/channel.errors';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { ChannelAdmissionService } from '@modules/payment/services/channel-admission.service';

import { noBlocks } from '../../helpers/blocklist';

const CHAIN = 'eip155:46630';
const ASSET = `${CHAIN}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac`;
const PAYER = getAddress(`0x${'aa'.repeat(20)}`);
const PROVIDER = getAddress(`0x${'bb'.repeat(20)}`);
const CHANNEL_ID = `0x${'5a'.repeat(32)}`;
const SIG = `0x${'11'.repeat(64)}1b`;
const NOW = 1_800_000_000;
const PRICE = 100_000n;

/** An in-memory stand-in for the three channel tables and the intent insert. */
function harness(
  options: {
    chainSettled?: bigint;
    open?: number;
    balance?: bigint;
    reserved?: bigint;
    /** The chain-state gate (`CHAIN_STATE_GATE`): what `assertActive` does. */
    chainState?: { assertActive: jest.Mock };
  } = {},
) {
  const lanes: any[] = [];
  const vouchers: any[] = [];
  const intents: any[] = [];
  const urgent: unknown[] = [];
  const channels = {
    manager: {},
    lockLane: jest.fn(
      async (_m: unknown, lane: any) =>
        lanes.find(
          (l) => l.channelId === lane.channelId.toLowerCase() && l.signer === lane.signer,
        ) ?? null,
    ),
    insertLane: jest.fn(async (_m: unknown, row: any) => {
      const lane = {
        id: randomUUID(),
        status: VoucherChannelStatus.OPEN,
        statusReason: null,
        lastAcceptedCumulative: '0',
        lastAcceptedCalls: 0,
        lastIssuedAt: null,
        settledCumulative: '0',
        ...row,
        channelId: row.channelId.toLowerCase(),
      };
      lanes.push(lane);
      return lane;
    }),
    countOpen: jest.fn(async () => options.open ?? 0),
    pendingOf: jest.fn(async (_m: unknown, id: string) =>
      intents
        .filter((i) => i.channelRowId === id && i.held !== true)
        .reduce((s, i) => s + i.price, 0n),
    ),
    insertVoucher: jest.fn(async (_m: unknown, row: any) => {
      const id = randomUUID();
      vouchers.push({ id, ...row });
      return id;
    }),
    advanceAccepted: jest.fn(async (_m: unknown, id: string, from: any, to: any) => {
      const lane = lanes.find((l) => l.id === id);
      if (BigInt(lane.lastAcceptedCumulative) !== from.cumulative) return false;
      Object.assign(lane, {
        lastAcceptedCumulative: to.cumulative.toString(),
        lastAcceptedCalls: to.calls,
        lastIssuedAt: String(to.issuedAt),
      });
      return true;
    }),
    // The message fields, not the signature bytes (final review backend F4).
    findReplay: jest.fn(
      async (
        laneId: string,
        cumulative: bigint,
        calls: number,
        times: { issuedAt: bigint | number; expiresAt: bigint | number },
      ) => {
        const v = vouchers.find(
          (x) =>
            x.channelRowId === laneId &&
            x.cumulative === cumulative.toString() &&
            x.calls === calls &&
            x.issuedAt === String(times.issuedAt) &&
            x.expiresAt === String(times.expiresAt),
        );
        return v ? { voucherId: v.id, intentId: v.intentId } : null;
      },
    ),
    findLaneByKey: jest.fn(
      async (_c: string, key: string) =>
        lanes.find((l) => l.channelKey === key.toLowerCase()) ?? null,
    ),
    setStatus: jest.fn(async (id: string, status: string, reason: string) => {
      const lane = lanes.find((l) => l.id === id);
      if (lane) Object.assign(lane, { status, statusReason: reason });
    }),
    requestUrgent: jest.fn(async (...args: unknown[]) => void urgent.push(args)),
  };
  const intentService = {
    create: jest.fn(async (input: any, admission: any) => {
      const open = {
        escrow: 0n,
        delegate: 0n,
        reserved: options.reserved ?? 0n,
        debts: 0,
        pausedFor: null,
      };
      admission.admit(open);
      const row: any = { id: randomUUID() };
      await admission.withinLock({}, row, open);
      const intent = {
        id: row.id,
        organizationId: input.organizationId,
        channelRowId: row.channelRowId,
        channelCumulative: input.channelCumulative,
        price: BigInt(input.price.amount),
      };
      intents.push(intent);
      return intent;
    }),
    secureFunds: jest.fn(async (_o: string, id: string) => intents.find((i) => i.id === id)),
    findById: jest.fn(async (_o: string, id: string) => intents.find((i) => i.id === id)),
    abandonUnsecuredVoucher: jest.fn(async () => undefined),
  };
  const door = {
    doorLive: jest.fn(async () => true),
    collectHoldSeconds: jest.fn(async () => 3_600),
    readBooks: jest.fn(async () => ({
      slot: { ...EMPTY_SLOT, settled: options.chainSettled ?? 0n },
      unpaid: 0n,
      totalUnpaid: 0n,
      held: 0n,
    })),
  };
  const adapter = {
    authorizeChannelSigner: jest.fn(async () => ({ kind: VoucherAuthorityKind.PAYER })),
    channelDomain: () => ({
      name: 'Assay Settlement',
      version: '2',
      chainId: 46630,
      verifyingContract: getAddress(`0x${'cd'.repeat(20)}`),
    }),
  };
  const service = new ChannelAdmissionService(
    intentService as never,
    channels as never,
    { resolve: () => adapter } as never,
    noBlocks(),
    door as never,
    new Set([CHAIN]),
    DEFAULT_CHANNEL_POLICY,
    undefined,
    () => NOW * 1000,
    (options.chainState ?? null) as never,
  );
  const call = (
    cumulative: bigint,
    calls: number,
    extra: Record<string, unknown> = {},
    signature: string = SIG,
  ) =>
    service.admit({
      organizationId: 'org',
      agentId: 'agent',
      agentAccount: `${CHAIN}:${PAYER}` as never,
      chainId: CHAIN as never,
      providerId: 'provider',
      providerAccount: `${CHAIN}:${PROVIDER}` as never,
      toolId: 'tool',
      requestHash: `sha256:${'ab'.repeat(32)}`,
      resource: '/mcp/tools/t',
      price: { amount: PRICE.toString(), asset: ASSET as never, decimals: 6 },
      platformFee: { amount: '10000', asset: ASSET as never, decimals: 6 },
      envelope: {
        voucher: {
          payer: PAYER,
          provider: PROVIDER,
          channelId: CHANNEL_ID,
          cumulative: cumulative.toString(),
          calls,
          issuedAt: NOW,
          expiresAt: NOW + 240,
          ...extra,
        },
        signature,
        providerId: 'provider',
      },
      boundDelegate: null,
      credentialId: null,
      escrow: {
        balance: { amount: (options.balance ?? 10_000_000n).toString(), asset: ASSET, decimals: 6 },
        withdrawRequested: 0n,
        withdrawAvailableAt: 0,
        maxVoucherAmount: 1_000_000n,
        maxPerWindow: 100_000_000n,
        spentInWindow: 0n,
        windowStartedAt: 0,
        seqHigh: 0n,
        observedAt: new Date(NOW * 1000),
      } as never,
      idempotencyKey: null,
    });
  return {
    service,
    channels,
    intentService,
    lanes,
    vouchers,
    intents,
    urgent,
    door,
    adapter,
    call,
  };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { errorCode?: string }).errorCode ?? (error as Error).message;
  }
};

describe('ChannelAdmissionService (v3 §5.3, SPEC-W2 §4)', () => {
  it('opens a lane at cumulative = price, calls = 1, then admits each next step', async () => {
    const h = harness();
    await h.call(PRICE, 1);
    await h.call(PRICE * 2n, 2);
    expect(h.lanes).toHaveLength(1);
    expect(h.lanes[0].lastAcceptedCumulative).toBe((PRICE * 2n).toString());
    expect(h.lanes[0].channelKey).toBe(
      channelKeyOf(PAYER, PAYER, PROVIDER, CHANNEL_ID as never).toLowerCase(),
    );
    expect(h.vouchers).toHaveLength(2);
  });

  it('refuses everything when the flag is off (CHANNEL_NOT_OFFERED)', async () => {
    const h = harness();
    (h.service as any).liveChains = new Set();
    expect(await code(h.call(PRICE, 1))).toBe(ChannelErrorCode.CHANNEL_NOT_OFFERED);
  });

  it('requires channels only on a chain that is both required and live', () => {
    const h = harness();
    expect(h.service.channelsRequiredOn(CHAIN as never)).toBe(false);
    (h.service as any).requiredChains = new Set([CHAIN, 'eip155:1']);
    expect(h.service.channelsRequiredOn(CHAIN as never)).toBe(true);
    // Required but not live: never enforced, or every paid call there would be refused.
    expect(h.service.channelsRequiredOn('eip155:1' as never)).toBe(false);
    (h.service as any).liveChains = new Set();
    expect(h.service.channelsRequiredOn(CHAIN as never)).toBe(false);
  });

  it('refuses per-call-only clients on a required chain unless the payer used a lane recently', async () => {
    const h = harness();
    const input = {
      chainId: CHAIN as never,
      asset: 'asset' as never,
      payer: `${CHAIN}:${PAYER}` as never,
    };
    const used = jest.fn(async () => false);
    (h.service as any).channels.usedChannelsRecently = used;
    expect(await h.service.refusesPerCallOnly(input)).toBe(false);
    expect(used).not.toHaveBeenCalled();

    (h.service as any).requiredChains = new Set([CHAIN]);
    expect(await h.service.refusesPerCallOnly(input)).toBe(true);
    expect(used).toHaveBeenCalledWith(`${CHAIN}:${PAYER}`, 'asset', 7);

    used.mockResolvedValueOnce(true);
    expect(await h.service.refusesPerCallOnly(input)).toBe(false);

    used.mockRejectedValueOnce(new Error('db down'));
    expect(await h.service.refusesPerCallOnly(input)).toBe(true);
  });

  it('refuses a hold above one hour', async () => {
    const h = harness();
    h.door.collectHoldSeconds.mockResolvedValue(7_200);
    expect(await code(h.call(PRICE, 1))).toBe(ChannelErrorCode.CHANNEL_NOT_OFFERED);
  });

  it('a first voucher must open at the price, against a chain slot that settled nothing', async () => {
    expect(await code(harness().call(PRICE * 2n, 2))).toBe(ChannelErrorCode.CHANNEL_DESYNC);
    expect(await code(harness({ chainSettled: 1n }).call(PRICE, 1))).toBe(
      ChannelErrorCode.CHANNEL_DESYNC,
    );
  });

  it('a gap kills the lane (DESYNC) — and nothing is reserved', async () => {
    const h = harness();
    await h.call(PRICE, 1);
    expect(await code(h.call(PRICE * 3n, 3))).toBe(ChannelErrorCode.CHANNEL_DESYNC);
    expect(h.lanes[0].status).toBe(VoucherChannelStatus.DESYNC);
    expect(h.intents).toHaveLength(1);
  });

  it('a replay of the exact voucher answers the stored result, whatever the key', async () => {
    const h = harness();
    const first = await h.call(PRICE, 1);
    const again = await h.call(PRICE, 1);
    expect(again.replayed).toBe(true);
    expect(again.intent.id).toBe(first.intent.id);
    expect(h.intents).toHaveLength(1);
  });

  it('A_cap: a channel whose pending would pass $5 answers PAYMENT_UNSETTLED_LIMIT, retryable, nothing stored', async () => {
    const h = harness();
    const big = 2_600_000n;
    (h as any).call = h.call;
    // Two calls of $2.6 → the second passes $5.
    const priced = (cumulative: bigint, calls: number) =>
      (h.service as any).admit({
        ...baseInput(h),
        price: { amount: big.toString(), asset: ASSET, decimals: 6 },
        envelope: env(cumulative, calls),
      });
    await priced(big, 1);
    expect(await code(priced(big * 2n, 2))).toBe(PaymentErrorCode.PAYMENT_UNSETTLED_LIMIT);
    expect(h.vouchers).toHaveLength(1);
    expect(h.lanes[0].lastAcceptedCumulative).toBe(big.toString());
  });

  it('a rotated lane answers CHANNEL_ROTATE', async () => {
    const h = harness();
    await h.call(PRICE, 1);
    h.lanes[0].status = VoucherChannelStatus.ROTATED;
    h.lanes[0].statusReason = 'DISPUTE_KEPT';
    expect(await code(h.call(PRICE * 2n, 2))).toBe(ChannelErrorCode.CHANNEL_ROTATE);
  });

  it('a new lane past the open-channel cap answers CHANNEL_LIMIT and asks for a round', async () => {
    const h = harness({ open: DEFAULT_CHANNEL_POLICY.maxOpenPerPayer });
    expect(await code(h.call(PRICE, 1))).toBe(ChannelErrorCode.CHANNEL_LIMIT);
    expect(h.urgent).toHaveLength(1);
  });

  it('refuses another session on the lane', async () => {
    const h = harness();
    await h.call(PRICE, 1);
    h.lanes[0].agentId = 'someone-else';
    expect(await code(h.call(PRICE * 2n, 2))).toBe(ChannelErrorCode.CHANNEL_DESYNC);
  });

  it('refuses a delegate within U + O + tick of its validUntil (CHANNEL_SIGNER_EXPIRING)', async () => {
    const h = harness();
    const delegate = `${CHAIN}:${getAddress(`0x${'dd'.repeat(20)}`)}`;
    h.adapter.authorizeChannelSigner.mockResolvedValue({
      kind: VoucherAuthorityKind.DELEGATE,
      delegate,
      terms: {
        maxVoucherAmount: 1_000_000n,
        maxPerWindow: 1_000_000_000n,
        carriedInWindow: 0n,
        validUntil: NOW + 3_600,
        redeemGraceSeconds: 7_200,
      },
    } as never);
    const input = { ...baseInput(h), boundDelegate: delegate };
    expect(await code((h.service as any).admit(input))).toBe(
      ChannelErrorCode.CHANNEL_SIGNER_EXPIRING,
    );
  });

  it('refuses a revoked delegate at once, even inside its on-chain grace', async () => {
    const h = harness();
    h.adapter.authorizeChannelSigner.mockResolvedValue({
      kind: 'REFUSED',
      reason: 'DELEGATE_REVOKED',
      signer: `${CHAIN}:${getAddress(`0x${'dd'.repeat(20)}`)}`,
    } as never);
    expect(await code(h.call(PRICE, 1))).toBe(PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_INACTIVE);
    expect(h.lanes).toHaveLength(0);
  });

  it('admits a delegate with more than U + O + tick left on its grant, and stores its validUntil', async () => {
    const h = harness();
    const delegate = `${CHAIN}:${getAddress(`0x${'dd'.repeat(20)}`)}`;
    h.adapter.authorizeChannelSigner.mockResolvedValue({
      kind: VoucherAuthorityKind.DELEGATE,
      delegate,
      terms: {
        maxVoucherAmount: 1_000_000n,
        maxPerWindow: 1_000_000_000n,
        carriedInWindow: 0n,
        validUntil: NOW + 3_661,
        redeemGraceSeconds: 7_200,
      },
    } as never);
    await (h.service as any).admit({ ...baseInput(h), boundDelegate: delegate });
    expect(h.channels.advanceAccepted).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ signerValidUntil: NOW + 3_661 }),
    );
  });

  it('the one reservation: refused when balance less everything promised cannot pay', async () => {
    const h = harness({ balance: 1_000_000n, reserved: 950_000n });
    expect(await code(h.call(PRICE, 1))).toMatch(/INSUFFICIENT/);
    expect(h.lanes).toHaveLength(0);
  });

  it('asks for an urgent round when the reservation passes 80% of available', async () => {
    const h = harness({ balance: 1_000_000n, reserved: 750_000n });
    await h.call(PRICE, 1);
    expect(h.urgent.some((args: any) => args[1] === 'RESERVATION')).toBe(true);
  });

  it('refuses a payer or provider that is not the session’s', async () => {
    const h = harness();
    const input = {
      ...baseInput(h),
      envelope: env(PRICE, 1, { provider: getAddress(`0x${'ee'.repeat(20)}`) }),
    };
    expect(await code((h.service as any).admit(input))).toBe(
      PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
    );
  });
});

describe('ChannelAdmissionService — review 2026-10-31 regressions', () => {
  it('L4: a replay is answered only to the session the lane is bound to', async () => {
    const h = harness();
    await h.call(PRICE, 1);
    // Another tenant sharing the payer key replays the exact voucher.
    expect(
      await code((h.service as any).admit({ ...baseInput(h), organizationId: 'other-org' })),
    ).toBe(ChannelErrorCode.CHANNEL_DESYNC);
    expect(h.intentService.findById).not.toHaveBeenCalled();
  });

  it('final review backend F4: a re-signed retry of the exact voucher is a replay, not a rewind', async () => {
    const h = harness();
    const SIG_B = `0x${'22'.repeat(64)}1c`; // same message, another valid signature (random k)
    await h.call(PRICE, 1);
    const first = await h.call(PRICE * 2n, 2);
    // The client timed out and retries call 2 with the same voucher, signed again.
    const retry = await h.call(PRICE * 2n, 2, {}, SIG_B);
    expect(retry.replayed).toBe(true);
    expect(retry.intent.id).toBe(first.intent.id);
    expect(h.lanes[0].status).toBe(VoucherChannelStatus.OPEN);
    // A different message at the same step (another expiry) is still a rewind.
    expect(await code(h.call(PRICE * 2n, 2, { expiresAt: NOW + 200 }, SIG_B))).toBe(
      ChannelErrorCode.CHANNEL_DESYNC,
    );
  });

  it('L5: the open-channel cap is counted again under the payer lock', async () => {
    const h = harness();
    // Outside the lock the payer looked under its cap; a concurrent open took the last lane.
    h.channels.countOpen
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(DEFAULT_CHANNEL_POLICY.maxOpenPerPayer as never);
    expect(await code(h.call(PRICE, 1))).toBe(ChannelErrorCode.CHANNEL_LIMIT);
    expect(h.urgent.some((args: any) => args[1] === 'CHANNEL_CAP')).toBe(true);
  });

  it('A_cap: retryAfter follows the next round, and a round is asked for', async () => {
    const h = harness();
    const big = 2_600_000n;
    const priced = (cumulative: bigint, calls: number) =>
      (h.service as any).admit({
        ...baseInput(h),
        price: { amount: big.toString(), asset: ASSET, decimals: 6 },
        envelope: env(cumulative, calls),
      });
    await priced(big, 1);
    const error = await (priced(big * 2n, 2) as Promise<unknown>).catch((e: unknown) => e);
    expect((error as { errorCode?: string }).errorCode).toBe(
      PaymentErrorCode.PAYMENT_UNSETTLED_LIMIT,
    );
    // NOW is on the minute: the tick at :15 runs the round, the next one lands it.
    expect((error as { context?: { retryAfter?: number } }).context?.retryAfter).toBe(75);
    expect(h.urgent.some((args: any) => args[1] === 'A_CAP')).toBe(true);
  });

  it('M7: voucher times are checked against the chain clock when the door has one', async () => {
    const h = harness();
    // The chain is 10 minutes behind the wall clock: a voucher issued for chain time passes.
    (h.door as any).chainNow = jest.fn(async () => NOW - 600);
    const input = {
      ...baseInput(h),
      envelope: env(PRICE, 1, { issuedAt: NOW - 600, expiresAt: NOW - 360 }),
    };
    expect(await code((h.service as any).admit(input))).toBeNull();
  });

  it('L6: renew refuses a call that is not a lapsed debt, and is rate-limited per lane', async () => {
    const h = harness();
    await h.call(PRICE, 1);
    const laneRow = h.lanes[0];
    const intent = {
      id: h.intents[0].id,
      organizationId: 'org',
      voucherFormat: 'CHANNEL',
      channelRowId: laneRow.id,
      channelCumulative: PRICE.toString(),
    };
    h.intentService.findById.mockResolvedValue(intent as never);
    (h.channels as any).findById = jest.fn(async () => laneRow);
    (h.channels as any).lapsedDebtsUpTo = jest.fn(async () => []);
    (h.channels as any).lastRenewAt = jest.fn(async () => null);
    const renew = () =>
      h.service.renew({
        organizationId: 'org',
        agentId: 'agent',
        intentId: intent.id,
        agentAccount: `${CHAIN}:${PAYER}` as never,
        boundDelegate: null,
        envelope: env(PRICE, 1),
      });
    expect(await code(renew())).toBe(PaymentErrorCode.PAYMENT_DEBT_NOT_FOUND);
    (h.channels as any).lapsedDebtsUpTo = jest.fn(async () => [
      { intentId: intent.id, writtenOff: false, replaced: false },
    ]);
    (h.channels as any).lastRenewAt = jest.fn(async () => new Date(NOW * 1000 - 60_000));
    expect(await code(renew())).toBe(PaymentErrorCode.PAYMENT_UNSETTLED_LIMIT);
  });

  it('final review backend F5: the renew rate uses the database clock only (app clock ahead)', async () => {
    const h = harness();
    await h.call(PRICE, 1);
    const laneRow = h.lanes[0];
    const intent = {
      id: h.intents[0].id,
      organizationId: 'org',
      voucherFormat: 'CHANNEL',
      channelRowId: laneRow.id,
      channelCumulative: PRICE.toString(),
    };
    h.intentService.findById.mockResolvedValue(intent as never);
    (h.channels as any).findById = jest.fn(async () => laneRow);
    (h.channels as any).lapsedDebtsUpTo = jest.fn(async () => [
      { intentId: intent.id, writtenOff: false, replaced: false },
    ]);
    // The DB wrote the last renew 5 s ago by its clock; the app clock runs an hour ahead.
    (h.channels as any).lastRenewAt = jest.fn(async () => new Date(NOW * 1000 - 3_600_000));
    (h.channels as any).lastRenewAgeSeconds = jest.fn(async () => 5);
    const renew = () =>
      h.service.renew({
        organizationId: 'org',
        agentId: 'agent',
        intentId: intent.id,
        agentAccount: `${CHAIN}:${PAYER}` as never,
        boundDelegate: null,
        envelope: env(PRICE, 1),
      });
    expect(await code(renew())).toBe(PaymentErrorCode.PAYMENT_UNSETTLED_LIMIT);
  });

  it('L4: the renew rate is read again under the payer lock, with the insert — a concurrent renew is refused', async () => {
    const h = harness();
    await h.call(PRICE, 1);
    const laneRow = h.lanes[0];
    h.intentService.findById.mockResolvedValue({
      id: h.intents[0].id,
      organizationId: 'org',
      voucherFormat: 'CHANNEL',
      channelRowId: laneRow.id,
      channelCumulative: PRICE.toString(),
    } as never);
    const queries: unknown[][] = [];
    const lockManager = { query: jest.fn(async (...args: unknown[]) => void queries.push(args)) };
    (h.channels as any).manager = { transaction: async (fn: any) => fn(lockManager) };
    (h.channels as any).findById = jest.fn(async () => laneRow);
    (h.channels as any).lapsedDebtsUpTo = jest.fn(async () => [
      { intentId: h.intents[0].id, writtenOff: false, replaced: false },
    ]);
    (h.channels as any).vouchers = jest.fn(async () => [
      { cumulative: PRICE.toString(), calls: 1 },
    ]);
    (h.channels as any).markReplaced = jest.fn(async () => 1);
    // Outside the lock: no renew yet. Under it: another renew just committed.
    (h.channels as any).lastRenewAt = jest.fn(async (_id: string, manager?: unknown) =>
      manager ? new Date(NOW * 1000 - 1_000) : null,
    );
    const insertVoucher = jest.spyOn(h.channels as any, 'insertVoucher');
    insertVoucher.mockClear();
    const error = await h.service
      .renew({
        organizationId: 'org',
        agentId: 'agent',
        intentId: h.intents[0].id,
        agentAccount: `${CHAIN}:${PAYER}` as never,
        boundDelegate: null,
        envelope: env(PRICE, 1),
      })
      .catch((e: unknown) => e);
    expect((error as { errorCode?: string }).errorCode).toBe(
      PaymentErrorCode.PAYMENT_UNSETTLED_LIMIT,
    );
    expect(queries[0]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`voucher-admission:${CHAIN}:${PAYER}`],
    ]);
    expect(insertVoucher).not.toHaveBeenCalled();
    expect((h.channels as any).markReplaced).not.toHaveBeenCalled();
  });

  it('M-2: a channel debt the payer settled per call is never renewed (it left its lane)', async () => {
    const h = harness();
    await h.call(PRICE, 1);
    // After the per-call replacement the row is PER_CALL with no lane.
    h.intentService.findById.mockResolvedValue({
      id: h.intents[0].id,
      organizationId: 'org',
      voucherFormat: 'PER_CALL',
      channelRowId: null,
    } as never);
    (h.channels as any).replacedPerCall = jest.fn(async () => true);
    const insertVoucher = jest.spyOn(h.channels as any, 'insertVoucher');
    insertVoucher.mockClear();
    const error = await h.service
      .renew({
        organizationId: 'org',
        agentId: 'agent',
        intentId: h.intents[0].id,
        agentAccount: `${CHAIN}:${PAYER}` as never,
        boundDelegate: null,
        envelope: env(PRICE, 1),
      })
      .catch((e: unknown) => e);
    expect((error as { errorCode?: string }).errorCode).toBe(ChannelErrorCode.CHANNEL_NOT_OFFERED);
    expect(String((error as { context?: { reason?: string } }).context?.reason)).toContain(
      'settled with a per-call voucher',
    );
    expect(insertVoucher).not.toHaveBeenCalled();
  });
});

describe('ChannelAdmissionService — the chain-state gate (sec-audit 2026-11-01 M-2)', () => {
  const refusing = (error: Error) => ({ assertActive: jest.fn(async () => Promise.reject(error)) });
  const requirementInput = {
    chainId: CHAIN as never,
    asset: ASSET as never,
    payer: `${CHAIN}:${PAYER}` as never,
    provider: `${CHAIN}:${PROVIDER}` as never,
    providerId: 'provider',
    price: { amount: PRICE.toString(), asset: ASSET, decimals: 6 } as never,
    delegate: null,
  };

  for (const [name, error] of [
    [
      'an EIP-712 domain mismatch',
      ChainErrors.domainMismatch({ chainId: CHAIN, contracts: 'escrow' }),
    ],
    ['a paused escrow', ChainErrors.programPaused({ chainId: CHAIN, door: 'REDEEM' })],
  ] as const) {
    it(`admit: ${name} refuses the channel voucher with the per-call error, nothing admitted`, async () => {
      const gate = refusing(error);
      const h = harness({ chainState: gate });
      const refused = await h.call(PRICE, 1).catch((e: unknown) => e);
      expect((refused as { errorCode?: string }).errorCode).toBe(
        (error as unknown as { errorCode: string }).errorCode,
      );
      expect(gate.assertActive).toHaveBeenCalledWith('REDEEM', [
        { role: 'PAYER', account: `${CHAIN}:${PAYER}` },
        { role: 'PAYEE', account: `${CHAIN}:${PROVIDER}` },
        { role: 'DELEGATE', account: null },
      ]);
      expect(h.intentService.create).not.toHaveBeenCalled();
      expect(h.channels.insertVoucher).not.toHaveBeenCalled();
    });

    it(`requirement: ${name} refuses the channel offer with the same error`, async () => {
      const h = harness({ chainState: refusing(error) });
      const refused = await h.service.requirement(requirementInput).catch((e: unknown) => e);
      expect((refused as { errorCode?: string }).errorCode).toBe(
        (error as unknown as { errorCode: string }).errorCode,
      );
    });
  }

  it('an active chain admits as before (control)', async () => {
    const gate = { assertActive: jest.fn(async () => undefined) };
    const h = harness({ chainState: gate });
    expect(await code(h.call(PRICE, 1))).toBeNull();
    expect(await h.service.requirement(requirementInput)).not.toBeNull();
    expect(gate.assertActive).toHaveBeenCalled();
  });
});

describe('ChannelAdmissionService.renew — bound to the lane agent (sec-audit 2026-11-01 B-L1)', () => {
  it('a session of another agent of the same payer cannot renew the lane, with a clear error', async () => {
    const h = harness();
    await h.call(PRICE, 1);
    const laneRow = h.lanes[0];
    h.intentService.findById.mockResolvedValue({
      id: h.intents[0].id,
      organizationId: 'org',
      voucherFormat: 'CHANNEL',
      channelRowId: laneRow.id,
      channelCumulative: PRICE.toString(),
    } as never);
    (h.channels as any).findById = jest.fn(async () => laneRow);
    (h.channels as any).lapsedDebtsUpTo = jest.fn(async () => [
      { intentId: h.intents[0].id, writtenOff: false, replaced: false },
    ]);
    (h.channels as any).lastRenewAt = jest.fn(async () => null);
    const insertVoucher = jest.spyOn(h.channels as any, 'insertVoucher');
    insertVoucher.mockClear();
    const error = await h.service
      .renew({
        organizationId: 'org',
        agentId: 'agent-B',
        intentId: h.intents[0].id,
        agentAccount: `${CHAIN}:${PAYER}` as never,
        boundDelegate: null,
        envelope: env(PRICE, 1),
      })
      .catch((e: unknown) => e);
    expect((error as { errorCode?: string }).errorCode).toBe(
      PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
    );
    expect(String((error as Error).message)).toContain('agent');
    expect(insertVoucher).not.toHaveBeenCalled();
  });
});

function env(cumulative: bigint, calls: number, extra: Record<string, unknown> = {}) {
  return {
    voucher: {
      payer: PAYER,
      provider: PROVIDER,
      channelId: CHANNEL_ID,
      cumulative: cumulative.toString(),
      calls,
      issuedAt: NOW,
      expiresAt: NOW + 240,
      ...extra,
    },
    signature: SIG,
    providerId: 'provider',
  };
}

function baseInput(_h: unknown) {
  return {
    organizationId: 'org',
    agentId: 'agent',
    agentAccount: `${CHAIN}:${PAYER}`,
    chainId: CHAIN,
    providerId: 'provider',
    providerAccount: `${CHAIN}:${PROVIDER}`,
    toolId: 'tool',
    requestHash: `sha256:${'ab'.repeat(32)}`,
    resource: '/mcp/tools/t',
    price: { amount: PRICE.toString(), asset: ASSET, decimals: 6 },
    platformFee: { amount: '10000', asset: ASSET, decimals: 6 },
    envelope: env(PRICE, 1),
    boundDelegate: null,
    credentialId: null,
    escrow: {
      balance: { amount: '10000000', asset: ASSET, decimals: 6 },
      withdrawRequested: 0n,
      withdrawAvailableAt: 0,
      maxVoucherAmount: 10_000_000n,
      maxPerWindow: 100_000_000n,
      spentInWindow: 0n,
      windowStartedAt: 0,
      seqHigh: 0n,
      observedAt: new Date(NOW * 1000),
    },
    idempotencyKey: null,
  };
}
