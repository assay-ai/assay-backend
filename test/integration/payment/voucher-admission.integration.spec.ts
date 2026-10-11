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
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { RedeemVoucherInput } from '@modules/payment/ports/voucher.types';
import { EscrowSeqService } from '@modules/payment/services/escrow-seq.service';
import { VoucherService } from '@modules/payment/services/voucher.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { deployment, EvmSigner, generateSigner } from '../../unit/chains/evm/evm-fixtures';
import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

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

  async getCode() {
    return undefined;
  }

  async readContract(args: { functionName: string; args: readonly unknown[] }): Promise<unknown> {
    if (args.functionName !== 'delegationOf') throw new Error(`unexpected ${args.functionName}`);
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
 * BUG-D1-02, against Postgres: five vouchers arriving at once for a window
 * with room for two. Before the fix every one of them read the same in-flight
 * sum, every one fit, and all five were served — the chain then refused three
 * at redemption and the platform paid the providers. The admission is now one
 * transaction under the payer's advisory lock, so exactly two are admitted,
 * whichever two win.
 *
 * Real `PaymentIntentService` (real holds in the real ledger), real
 * `EvmChainAdapter` and real secp256k1 keys; only the chain's storage and the
 * seq allocator are stand-ins.
 */
describe('Voucher admission — concurrent vouchers against one window (BUG-D1-02)', () => {
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
    service = new VoucherService(context.intents, new ChainAdapterRegistry([adapter], [CHAIN]), {
      wasIssued: async () => true,
    } as unknown as EscrowSeqService);
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

  async function race(inputs: RedeemVoucherInput[]) {
    const results = await Promise.allSettled(inputs.map((each) => service.redeem(each)));
    const admitted = results.filter((result) => result.status === 'fulfilled');
    const refused = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason as { errorCode?: string }).errorCode ?? result.reason);
    return { admitted, refused };
  }

  it("admits exactly what fits the delegate's window when five vouchers arrive at once", async () => {
    // 0.5 per voucher, 1.3 per window: room for two.
    grant(500_000n, 1_300_000n);
    const { admitted, refused } = await race(
      Array.from({ length: 5 }, () => input(delegate, 500_000n)),
    );

    expect(admitted).toHaveLength(2);
    expect(refused).toEqual(
      Array(3).fill(PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_LIMIT_EXCEEDED),
    );
    for (const result of admitted) {
      expect((result as PromiseFulfilledResult<{ status: string }>).value.status).toBe(
        PaymentIntentStatus.FUNDS_SECURED,
      );
    }
  });

  it("admits exactly what fits the escrow's own window on the payer's own key", async () => {
    const reading = escrow({ maxPerWindow: 1_300_000n });
    const { admitted, refused } = await race(
      Array.from({ length: 5 }, () => input(payer, 500_000n, reading)),
    );

    expect(admitted).toHaveLength(2);
    expect(refused).toEqual(Array(3).fill(PaymentErrorCode.PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED));
  });

  it("counts a delegate's vouchers against the escrow's window too, and the payer's against neither cap of the delegate", async () => {
    grant(500_000n, 10_000_000n);
    const reading = escrow({ maxPerWindow: 1_500_000n });
    await service.redeem(input(payer, 500_000n, reading));
    const { admitted, refused } = await race([
      input(delegate, 500_000n, reading),
      input(delegate, 500_000n, reading),
      input(delegate, 500_000n, reading),
    ]);

    expect(admitted).toHaveLength(2);
    expect(refused).toEqual([PaymentErrorCode.PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED]);
  });

  it("adds the chain's decayed counter, and a voucher redeemed after the chain was read", async () => {
    grant(500_000n, 10_000_000n);
    const read = new Date(Date.now() - 120_000);
    // On chain: 0.5 counted, half decayed (0.25 left). The window is 1.0.
    const reading = escrow({
      maxPerWindow: 1_000_000n,
      spentInWindow: 500_000n,
      windowStartedAt: Math.floor(Date.now() / 1000) - 43_200,
      observedAt: read,
    });
    // A voucher redeemed AFTER that read: its hold is closed, and the counter
    // read above cannot contain it.
    const redeemed = await service.redeem(input(payer, 500_000n, null));
    await context.dataSource.query(
      `UPDATE "payment_intents" SET "status" = 'SETTLED', "hold_released_at" = now() WHERE "id" = $1`,
      [redeemed.id],
    );

    // 0.25 carried + 0.5 redeemed after the read = 0.75: 0.25 is left. The
    // counter keeps draining (about 6 units a second), so the bounds sit 100
    // units either side rather than on the unit.
    await expect(service.redeem(input(payer, 250_100n, reading))).rejects.toMatchObject({
      errorCode: PaymentErrorCode.PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED,
    });
    await expect(service.redeem(input(payer, 249_900n, reading))).resolves.toBeDefined();
  });

  it('gives the window back when the funds could not be secured', async () => {
    grant(500_000n, 600_000n);
    const poor = generateSigner(CHAIN);
    payer = poor; // never funded
    chain.grants.set(`${poor.address.toLowerCase()}:${delegate.address.toLowerCase()}`, {
      maxVoucherAmount: 500_000n,
      maxPerWindow: 600_000n,
      spentInWindow: 0n,
      windowStartedAt: 0n,
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400),
      listPosition: 1,
      revoked: false,
    });
    await expect(service.redeem(input(delegate, 500_000n))).rejects.toBeDefined();

    await context.ledger.appendNow({
      organizationId: context.organizationId,
      accountId: poor.account,
      entryType: LedgerEntryType.DEPOSIT,
      money: usdg(10_000_000n),
    });
    await expect(service.redeem(input(delegate, 500_000n))).resolves.toBeDefined();
  });
});
