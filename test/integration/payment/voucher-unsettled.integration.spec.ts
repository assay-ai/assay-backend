import { randomUUID } from 'node:crypto';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import { EscrowChainBalance } from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { computeRequestHash } from '@modules/payment/domain/request-hash';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { RedeemVoucherInput } from '@modules/payment/ports/voucher.types';
import { EscrowSeqService } from '@modules/payment/services/escrow-seq.service';
import { VoucherService } from '@modules/payment/services/voucher.service';
import { EscrowDelegationStatus } from '@modules/settlement/ports/escrow-delegation.port';
import { EscrowDelegationService } from '@modules/settlement/services/escrow-delegation.service';
import { DEFAULT_EVM_RELAYER_TIMING } from '@modules/chains/evm/evm-relayer-timing';
import {
  tighteningHoldMs,
  UnsettledVoucherGuard,
} from '@modules/settlement/services/unsettled-voucher-guard.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { deployment, EvmSigner, generateSigner } from '../../unit/chains/evm/evm-fixtures';
import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';
import { noBlocks } from '../../unit/helpers/blocklist';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET as AssetId;
const DEPLOYMENT = deployment(CHAIN);
const ESCROW = `${CHAIN}:${DEPLOYMENT.escrow}` as AccountId;
const PROVIDER = `${CHAIN}:0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2` as AccountId;
const RESOURCE = '/mcp/tools/get_weather';
const usdg = (atomic: bigint) => MoneyUtil.of(atomic, USDG, 6);

/** The delegation records the adapter reads (`delegationOf`), and nothing else. */
class FakeEvmChain {
  grants = new Map<string, Record<string, unknown>>();
  /** Set by a test: every `delegationOf` read waits for this first (a barrier). */
  gate: Promise<void> | null = null;
  /** How many reads are waiting at the gate. */
  waiting = 0;

  async getCode() {
    return undefined;
  }

  async readContract(args: { functionName: string; args: readonly unknown[] }): Promise<unknown> {
    if (args.functionName !== 'delegationOf') throw new Error(`unexpected ${args.functionName}`);
    if (this.gate) {
      this.waiting += 1;
      await this.gate;
    }
    const [payer, delegate] = args.args as string[];
    return (
      this.grants.get(`${payer.toLowerCase()}:${delegate.toLowerCase()}`) ?? {
        maxVoucherAmount: 0n,
        maxPerWindow: 0n,
        spentInWindow: 0n,
        windowStartedAt: 0n,
        validUntil: 0n,
        listPosition: 0,
        revoked: false,
      }
    );
  }
}

/**
 * BUG-D1-07, against Postgres: lowering a cap below what served, unredeemed
 * vouchers need strands them. The unsettled figures are read from the real
 * `payment_intents` (vouchers admitted through the real `VoucherService`), the
 * refusal is the real guard's, and the admission pause is the real advisory
 * lock and `voucher_admission_pauses` row.
 */
describe('Lowering caps with vouchers in flight (BUG-D1-07)', () => {
  let context: PaymentTestContext;
  let chain: FakeEvmChain;
  let adapter: EvmChainAdapter;
  let service: VoucherService;
  let payer: EvmSigner;
  let delegate: EvmSigner;
  let seq = 0n;

  beforeAll(async () => {
    context = await createPaymentTestContext();
    // An EVM signature is 132 characters. Production widened the column in
    // `1759300000000-widen-signature-and-account-columns`, which also alters
    // tables this harness does not create; only the column this suite writes
    // is widened here (idempotent).
    await context.dataSource.query(
      `ALTER TABLE "payment_intents" ALTER COLUMN "voucher_signature" TYPE varchar(256)`,
    );
  }, 300_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    chain = new FakeEvmChain();
    adapter = new EvmChainAdapter(
      new Map([[CHAIN, chain as never]]),
      new Map([[CHAIN, DEPLOYMENT]]),
      [CHAIN],
    );
    service = new VoucherService(
      context.intents,
      new ChainAdapterRegistry([adapter], [CHAIN]),
      { wasIssued: async () => true } as unknown as EscrowSeqService,
      noBlocks(),
    );
    payer = generateSigner(CHAIN);
    delegate = generateSigner(CHAIN);
    await context.ledger.appendNow({
      organizationId: context.organizationId,
      accountId: payer.account,
      entryType: LedgerEntryType.DEPOSIT,
      money: usdg(100_000_000n),
    });
  });

  /** The payer's escrow as the MCP path reads it for the call. */
  function escrow(overrides: Partial<EscrowChainBalance> = {}): EscrowChainBalance {
    return {
      balance: usdg(100_000_000n),
      seqHigh: 0n,
      withdrawRequested: 0n,
      withdrawAvailableAt: 0,
      maxVoucherAmount: 1_000_000n,
      maxPerWindow: 10_000_000n,
      spentInWindow: 0n,
      windowStartedAt: 0,
      observedAt: new Date(),
      ...overrides,
    };
  }

  function grant(maxVoucherAmount: bigint, maxPerWindow: bigint): void {
    chain.grants.set(`${payer.address.toLowerCase()}:${delegate.address.toLowerCase()}`, {
      maxVoucherAmount,
      maxPerWindow,
      spentInWindow: 0n,
      windowStartedAt: 0n,
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400),
      listPosition: 1,
      revoked: false,
    });
  }

  function input(
    signer: EvmSigner,
    amount: bigint,
    reading: EscrowChainBalance | null = escrow(),
  ): RedeemVoucherInput {
    const now = Math.floor(Date.now() / 1000);
    const call = { method: 'POST', path: RESOURCE, query: {}, body: { latitude: 10.8 } };
    const toolId = '11111111-1111-4111-8111-111111111111';
    const providerId = '22222222-2222-4222-8222-222222222222';
    seq += 1n;
    const voucher: Voucher = {
      payer: payer.account,
      payTo: ESCROW,
      provider: PROVIDER,
      amount: usdg(amount),
      resource: RESOURCE,
      requestHash: computeRequestHash({
        ...call,
        toolId,
        providerId,
        amount: amount.toString(),
        asset: USDG,
      }),
      seq: seq.toString(),
      issuedAt: now - 5,
      expiresAt: now + 240,
    };
    return {
      organizationId: context.organizationId,
      signed: { voucher, signature: signer.sign(adapter.buildVoucherMessage(voucher)) },
      call,
      agentId: randomUUID(),
      agentAccount: payer.account,
      providerId,
      providerAccount: PROVIDER,
      toolId,
      resource: RESOURCE,
      escrowPda: ESCROW,
      price: usdg(amount),
      platformFee: usdg(amount / 10n),
      chainId: CHAIN,
      boundDelegate: delegate.account,
      escrow: reading,
    };
  }

  let guard: UnsettledVoucherGuard;

  beforeEach(() => {
    guard = new UnsettledVoucherGuard(context.repository);
  });

  const delegateScope = (carried = 0n) => ({
    payer: payer.account,
    asset: USDG,
    delegate: delegate.account,
    carried,
    readAt: new Date(),
  });

  it('counts the served, unredeemed vouchers of the delegate, and of the whole payer', async () => {
    grant(500_000n, 10_000_000n);
    await service.redeem(input(delegate, 100_000n));
    await service.redeem(input(delegate, 300_000n));
    await service.redeem(input(payer, 200_000n));

    const mine = await guard.read(delegateScope(2_270_000n));
    expect(mine).toMatchObject({ count: 2, total: 400_000n, largest: 300_000n });
    expect(mine.windowNeeds).toBe(2_270_000n + 400_000n);
    expect(mine.redeemableUntil).not.toBeNull();

    const all = await guard.read({ ...delegateScope(), delegate: null });
    expect(all).toMatchObject({ count: 3, total: 600_000n, largest: 300_000n });
  });

  it('stops counting a voucher once the chain has redeemed it', async () => {
    grant(500_000n, 10_000_000n);
    const served = await service.redeem(input(delegate, 100_000n));
    await context.dataSource.query(
      `UPDATE "payment_intents" SET "status" = 'SETTLED', "hold_released_at" = now() WHERE "id" = $1`,
      [served.id],
    );
    // Read with the counter taken before that redemption: it is counted in the
    // window need (the counter may not hold it), not as still in flight.
    const unsettled = await guard.read({
      ...delegateScope(),
      readAt: new Date(Date.now() - 60_000),
    });
    expect(unsettled.count).toBe(0);
  });

  it('BUG-D1-07: refuses to lower the window below counter + in flight, unless acknowledged', async () => {
    grant(500_000n, 5_000_000n);
    await service.redeem(input(delegate, 100_000n)); // seq 94 in the retest: served, not on chain
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
    const port = {
      list: async () => [
        {
          delegate: delegate.account,
          maxVoucherAmount: 500_000n,
          maxPerWindow: 5_000_000n,
          spentInWindow: 2_270_000n,
          validUntil,
          status: EscrowDelegationStatus.ACTIVE,
        },
      ],
      authorizeIntent: async () => ({ kind: 'typed-data' }),
      revokeIntent: async () => ({ kind: 'typed-data' }),
    };
    const delegation = new EscrowDelegationService(
      port as never,
      { assertRelayRoom: async () => undefined } as never,
      { assetFor: async () => USDG } as never,
      guard,
    );
    const terms = {
      delegate: delegate.account,
      maxVoucherAmount: 500_000n,
      maxPerWindow: 2_000_000n,
      validUntil,
    };

    await expect(
      delegation.authorizeIntent(context.organizationId, payer.account, terms),
    ).rejects.toMatchObject({ errorCode: 'SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK' });
    await expect(
      delegation.authorizeIntent(context.organizationId, payer.account, terms, true),
    ).resolves.toEqual({ kind: 'typed-data' });
    const [listed] = await delegation.list(payer.account);
    expect(listed.unsettled).toMatchObject({ count: 1, total: 100_000n, windowNeeds: 2_370_000n });
  });

  /** The signed request's deadline: chain now + 300 s, as the intent builder sets it. */
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 300);

  /** Moves every pause of the payer back in time, as if `seconds` had passed. */
  async function age(seconds: number): Promise<void> {
    await context.dataSource.query(
      `UPDATE "voucher_admission_pauses"
          SET "paused_until" = "paused_until" - make_interval(secs => $2),
              "landed_at" = "landed_at" - make_interval(secs => $2)
        WHERE "payer_account" = $1`,
      [payer.account, seconds],
    );
  }

  const paused = { errorCode: PaymentErrorCode.PAYMENT_VOUCHER_ADMISSION_PAUSED };

  it('admits no voucher while a tightening is relayed, nor for the chain-lag margin after it lands', async () => {
    grant(500_000n, 10_000_000n);
    let during: unknown;
    await guard.relayTightening({
      scope: delegateScope(),
      lowered: { maxPerWindow: 9_000_000n },
      acknowledged: false,
      deadline: deadline(),
      relay: async () => {
        during = await service.redeem(input(delegate, 100_000n)).catch((error: unknown) => error);
      },
    });
    expect(during).toMatchObject(paused);
    // Still paused for the settle margin after the landing...
    await expect(service.redeem(input(delegate, 100_000n))).rejects.toMatchObject(paused);
    // ...and admitting again once it has passed, for a read taken after it.
    await age(31);
    await expect(service.redeem(input(delegate, 100_000n))).resolves.toBeDefined();
  });

  /**
   * REGRESSION (review finding 1): request B of the same payer, refused by
   * name, used to set the payer's one `paused_until` to now while request A was
   * still being relayed. Each request now holds and ends its own row.
   */
  it('a second tightening refused by name leaves the first one’s pause in force', async () => {
    grant(500_000n, 10_000_000n);
    let landA!: () => void;
    const a = guard.relayTightening({
      scope: delegateScope(),
      lowered: { maxPerWindow: 9_000_000n },
      acknowledged: true,
      deadline: deadline(),
      relay: () => new Promise<void>((resolve) => (landA = resolve)),
    });
    while (!landA) await new Promise((resolve) => setImmediate(resolve));

    await expect(
      guard.relayTightening({
        scope: delegateScope(),
        lowered: { maxPerWindow: 8_000_000n },
        acknowledged: true,
        deadline: deadline(),
        relay: async () => {
          throw Object.assign(new Error('rate limited'), {
            errorCode: 'SETTLEMENT_RELAYED_INTENT_RATE_LIMITED',
          });
        },
      }),
    ).rejects.toThrow('rate limited');
    await expect(service.redeem(input(delegate, 100_000n))).rejects.toMatchObject(paused);

    landA();
    await a;
    await expect(service.redeem(input(delegate, 100_000n))).rejects.toMatchObject(paused);
  });

  /**
   * REGRESSION (review finding 2): the pause was a fixed 120 s, so a relay
   * still queued or waiting for its receipt at 121 s let vouchers in under the
   * old caps. A pending relay's pause now lasts at least the relayer's whole
   * send budget, and never ends before the signed request's deadline.
   */
  it('keeps the pause of a pending relay past 120 s, for the relayer’s budget and the deadline', async () => {
    grant(500_000n, 10_000_000n);
    let land!: () => void;
    const signedDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const pending = guard.relayTightening({
      scope: delegateScope(),
      lowered: { maxPerWindow: 9_000_000n },
      acknowledged: true,
      deadline: signedDeadline,
      relay: () => new Promise<void>((resolve) => (land = resolve)),
    });
    while (!land) await new Promise((resolve) => setImmediate(resolve));

    const [row] = (await context.dataSource.query(
      `SELECT EXTRACT(EPOCH FROM ("paused_until" - now()))::int AS "left",
              EXTRACT(EPOCH FROM "paused_until")::bigint AS "until"
         FROM "voucher_admission_pauses" WHERE "payer_account" = $1`,
      [payer.account],
    )) as Array<{ left: number; until: string }>;
    expect(row.left).toBeGreaterThanOrEqual(
      Math.floor(tighteningHoldMs(DEFAULT_EVM_RELAYER_TIMING) / 1000) - 2,
    );
    expect(Number(row.until)).toBeGreaterThanOrEqual(Number(signedDeadline) + 30);
    // 121 s into the relay, as the review's proof had it: still paused.
    await age(121);
    await expect(service.redeem(input(delegate, 100_000n))).rejects.toMatchObject(paused);

    land();
    await pending;
  });

  /**
   * REGRESSION (review finding 3): the pause was compared with the INSERT
   * time, so a voucher whose chain read predated the landing (old caps) was
   * admitted once the 15 s margin had passed. It is now compared with the
   * admission's own chain read.
   */
  it('refuses a voucher whose chain read predates the landing, however late its insert', async () => {
    grant(500_000n, 10_000_000n);
    await guard.relayTightening({
      scope: { ...delegateScope(), delegate: null },
      lowered: { maxPerWindow: 9_000_000n },
      acknowledged: true,
      deadline: deadline(),
      relay: async () => undefined,
    });
    await age(40); // landed 40 s ago; its 30 s margin has run out
    const stale = escrow({ observedAt: new Date(Date.now() - 45_000) }); // read before the landing
    await expect(service.redeem(input(payer, 100_000n, stale))).rejects.toMatchObject(paused);
    await expect(service.redeem(input(payer, 100_000n))).resolves.toBeDefined();
  });

  /** Review finding 6: a delegate's change pauses that delegate; the escrow's, everyone. */
  it('pauses only the delegate for a change of its grant, and every signer for the escrow’s limits', async () => {
    grant(500_000n, 10_000_000n);
    let land!: () => void;
    const delegateChange = guard.relayTightening({
      scope: delegateScope(),
      lowered: { revoked: true },
      acknowledged: true,
      deadline: deadline(),
      relay: () => new Promise<void>((resolve) => (land = resolve)),
    });
    while (!land) await new Promise((resolve) => setImmediate(resolve));
    await expect(service.redeem(input(delegate, 100_000n))).rejects.toMatchObject(paused);
    await expect(service.redeem(input(payer, 100_000n))).resolves.toBeDefined();
    land();
    await delegateChange;

    let landLimits!: () => void;
    const limitsChange = guard.relayTightening({
      scope: { ...delegateScope(), delegate: null },
      lowered: { maxPerWindow: 9_000_000n },
      acknowledged: true,
      deadline: deadline(),
      relay: () => new Promise<void>((resolve) => (landLimits = resolve)),
    });
    while (!landLimits) await new Promise((resolve) => setImmediate(resolve));
    await expect(service.redeem(input(payer, 100_000n))).rejects.toMatchObject(paused);
    landLimits();
    await limitsChange;
  });

  /**
   * Review finding 7: every voucher racing the check is either in its count or
   * refused by the pause — with a barrier, so BOTH branches run every time
   * (the old version also passed with 8 = 8 or 0 = 0).
   */
  it('every voucher racing the check is either in its count or refused by the pause', async () => {
    grant(500_000n, 100_000_000n);
    let open!: () => void;
    chain.gate = new Promise<void>((resolve) => (open = resolve));
    // Released together, the early four reach the payer's lock in any order,
    // and one below a seq already admitted is refused PAYMENT_VOUCHER_SEQ_STALE
    // (final review N-6): retryable with a fresh seq, which an agent does.
    const admitRetryingStale = async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await service.redeem(input(delegate, 100_000n));
        } catch (error) {
          const stale =
            (error as { errorCode?: string }).errorCode ===
            PaymentErrorCode.PAYMENT_VOUCHER_SEQ_STALE;
          if (!stale || attempt >= 10) throw error;
        }
      }
    };
    const early = Array.from({ length: 4 }, admitRetryingStale);
    while (chain.waiting < 4) await new Promise((resolve) => setImmediate(resolve));
    open();
    await Promise.all(early); // admitted before the hold
    let openLate!: () => void;
    chain.gate = new Promise<void>((resolve) => (openLate = resolve));
    const lateBase = chain.waiting;
    const late = Array.from({ length: 4 }, () => service.redeem(input(delegate, 100_000n)));
    while (chain.waiting < lateBase + 4) await new Promise((resolve) => setImmediate(resolve));

    const { pauseId, totals } = await context.repository.holdVoucherAdmission(
      { payer: payer.account, delegate: delegate.account, holdSeconds: 60 },
      [{ payer: payer.account, assetId: USDG, delegate: delegate.account, since: new Date() }],
    );
    openLate(); // read before the hold committed, inserting after it
    const results = await Promise.allSettled([...early, ...late]);
    const admitted = results.filter((result) => result.status === 'fulfilled');
    const refused = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason as { errorCode?: string }).errorCode);

    expect(admitted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    expect(
      refused.every((code) => code === PaymentErrorCode.PAYMENT_VOUCHER_ADMISSION_PAUSED),
    ).toBe(true);
    expect(totals[0].count).toBe(admitted.length);
    await context.repository.releaseVoucherAdmissionPause(pauseId);
    chain.gate = null;
  });

  /** Review finding 13: the boot check passes on a migrated database. */
  it('finds the pause table in its per-request shape', async () => {
    await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
