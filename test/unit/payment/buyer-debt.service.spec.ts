import { randomUUID } from 'node:crypto';

import {
  LapsedVoucherReplacement,
  OutstandingDebt,
} from '@database/postgres/repositories/payment-intent.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import { EscrowChainBalance } from '@modules/ledger/ports/escrow-balance-reader.port';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { BuyerDebtService } from '@modules/payment/services/buyer-debt.service';
import { EscrowSeqService } from '@modules/payment/services/escrow-seq.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { VoucherService } from '@modules/payment/services/voucher.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { deployment, EvmSigner, generateSigner } from '../chains/evm/evm-fixtures';
import { noBlocks } from '../helpers/blocklist';
import { FakeEscrowSeqService, InMemoryIntentWriter } from './helpers/voucher-harness';

/**
 * Settling buyer debt (no-platform-debt design, step 10): the buyer signs a
 * replacement voucher for the served call — the same payer, escrow, provider,
 * amount and requestHash, a fresh seq — and the intent goes back to the
 * redemption queue. `VoucherService` and the EVM adapter are the real ones;
 * only the database and the chain reads are stood in for.
 */
const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const DEPLOYMENT = deployment(CHAIN);
const ESCROW = `${CHAIN}:${DEPLOYMENT.escrow}` as AccountId;
const PROVIDER = `${CHAIN}:0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2` as AccountId;
const TOOL_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_HASH = `sha256:${'cd'.repeat(32)}`;

/** A chain on which nobody is anybody's delegate. */
class FakeEvmChain {
  async readContract(args: { functionName: string }): Promise<unknown> {
    if (args.functionName === 'delegationOf') {
      return {
        maxVoucherAmount: 0n,
        maxPerWindow: 0n,
        spentInWindow: 0n,
        windowStartedAt: 0n,
        validUntil: 0n,
        listPosition: 0,
        revoked: false,
      };
    }
    if (args.functionName === 'isValidSignature') return '0xffffffff';
    throw new Error(`unexpected read ${args.functionName}`);
  }
}

function escrowReading(overrides: Partial<EscrowChainBalance> = {}): EscrowChainBalance {
  return {
    balance: MoneyUtil.of(100_000_000n, USDG, 6),
    seqHigh: 4n,
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

function build() {
  const payer: EvmSigner = generateSigner(CHAIN);
  const organizationId = randomUUID();
  const adapter = new EvmChainAdapter(
    new Map([[CHAIN, new FakeEvmChain() as never]]),
    new Map([[CHAIN, DEPLOYMENT]]),
    [CHAIN],
  );
  const chains = new ChainAdapterRegistry([adapter], [CHAIN]);
  const seqs = new FakeEscrowSeqService();
  seqs.jumpTo(5n);
  const seqService = Object.assign(seqs, {
    allocate: jest.fn(async () => ({
      seq: seqs.advance().toString(),
      escrowPda: DEPLOYMENT.escrow,
      escrowTokenAccount: DEPLOYMENT.escrow,
    })),
  });
  const vouchers = new VoucherService(
    new InMemoryIntentWriter() as unknown as PaymentIntentService,
    chains,
    seqService as unknown as EscrowSeqService,
    noBlocks(),
  );

  const debt: OutstandingDebt = {
    id: randomUUID(),
    organizationId,
    agentAccount: payer.account,
    providerId: randomUUID(),
    providerAccount: PROVIDER,
    toolId: TOOL_ID,
    chainId: CHAIN,
    assetId: USDG,
    decimals: 6,
    priceAmount: '50000',
    requestHash: REQUEST_HASH,
    voucherResourceHash: 'ab'.repeat(32),
    voucherSeq: '3',
    lapsedAt: new Date('2026-10-16T00:00:00Z'),
    cause: 'DelegateIsRevoked',
    createdAt: new Date('2026-10-15T23:55:00Z'),
  };
  const debts: OutstandingDebt[] = [debt];
  const replaced: Array<{ id: string; replacement: LapsedVoucherReplacement }> = [];
  const open = { nextSeq: 100n as bigint | null, maxSeq: 2n as bigint | null };
  const payments = {
    findOutstandingDebts: jest.fn(async () => [...debts]),
    replaceLapsedVoucher: jest.fn(
      async (
        _org: string,
        id: string,
        _payer: string,
        replacement: LapsedVoucherReplacement,
        admit: (o: typeof open) => void,
      ) => {
        admit(open);
        replaced.push({ id, replacement });
        debts.splice(
          debts.findIndex((d) => d.id === id),
          1,
        );
        return true;
      },
    ),
  };
  const escrow = {
    read: jest.fn(async () => escrowReading()),
    escrowAddresses: jest.fn(async () => ({ escrowPda: ESCROW, escrowTokenAccount: ESCROW })),
  };
  const tools = {
    findTool: jest.fn(async () => ({ id: TOOL_ID, name: 'get_weather' })),
  };
  const service = new BuyerDebtService(
    payments as never,
    vouchers,
    seqService as unknown as EscrowSeqService,
    chains,
    escrow as never,
    tools as never,
  );
  const session: McpSession = {
    organizationId,
    agentId: randomUUID(),
    agentAccount: payer.account,
    chainId: CHAIN,
    credentialId: 'human',
    callerKind: McpCallerKind.HUMAN,
  } as unknown as McpSession;
  const sign = (voucher: Voucher, signer: EvmSigner = payer) =>
    signer.sign(adapter.buildVoucherMessage(voucher));
  return { service, payments, debt, replaced, open, session, sign, payer, adapter };
}

describe('BuyerDebtService — settling a debt with a replacement voucher', () => {
  it('lists the open debts with the write-off date, 30 days after the lapse', async () => {
    const { service, session, debt } = build();
    const listed = await service.list(session);
    expect(listed).toEqual([
      expect.objectContaining({
        intentId: debt.id,
        amount: { amount: '50000', asset: USDG, decimals: 6 },
        cause: 'DelegateIsRevoked',
        lapsedAt: '2026-10-16T00:00:00.000Z',
        writeOffAt: '2026-11-15T00:00:00.000Z',
      }),
    ]);
  });

  it('builds the replacement: the served call’s own terms, a fresh seq, and EIP-712 typed data', async () => {
    const { service, session, debt, adapter } = build();
    const intent = await service.voucherIntent(session, debt.id);

    expect(intent.voucher).toMatchObject({
      payer: session.agentAccount,
      payTo: ESCROW,
      provider: PROVIDER,
      amount: { amount: '50000', asset: USDG, decimals: 6 },
      resource: '/mcp/tools/get_weather',
      requestHash: REQUEST_HASH,
      seq: '5',
    });
    expect(intent.voucher.expiresAt - intent.voucher.issuedAt).toBe(300);
    expect(intent.signers).toEqual(['payer', 'delegate']);
    expect(intent.typedData).toMatchObject({
      primaryType: 'Voucher',
      message: expect.objectContaining({ seq: '5', amount: '50000' }),
    });
    // The typed data is exactly what `buildVoucherMessage` hashes.
    expect(adapter.voucherTypedData(intent.voucher)).toEqual(intent.typedData);
  });

  it('accepts the payer-signed replacement and reopens the call to redemption', async () => {
    const { service, session, debt, replaced, sign } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);

    const settled = await service.settle(session, debt.id, { voucher, signature: sign(voucher) });

    expect(settled).toEqual({ intentId: debt.id, seq: '5', remainingDebts: 0 });
    expect(replaced).toEqual([
      {
        id: debt.id,
        replacement: expect.objectContaining({
          seq: '5',
          delegate: null,
          issuedAt: voucher.issuedAt,
          expiresAt: new Date(voucher.expiresAt * 1000),
        }),
      },
    ]);
  });

  it('refuses a replacement for a different amount, and changes nothing', async () => {
    const { service, session, debt, replaced, sign } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);
    const cheaper = { ...voucher, amount: MoneyUtil.of(1n, USDG, 6) };

    await expect(
      service.settle(session, debt.id, { voucher: cheaper, signature: sign(cheaper) }),
    ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH });
    expect(replaced).toEqual([]);
  });

  it('refuses a replacement bound to another request', async () => {
    const { service, session, debt, replaced, sign } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);
    const other = { ...voucher, requestHash: `sha256:${'ee'.repeat(32)}` };

    await expect(
      service.settle(session, debt.id, { voucher: other, signature: sign(other) }),
    ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_REQUEST_HASH_MISMATCH });
    expect(replaced).toEqual([]);
  });

  it('refuses a replacement signed by somebody else', async () => {
    const { service, session, debt, replaced, sign } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);

    await expect(
      service.settle(session, debt.id, {
        voucher,
        signature: sign(voucher, generateSigner(CHAIN)),
      }),
    ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_VOUCHER_SIGNATURE_INVALID });
    expect(replaced).toEqual([]);
  });

  it('refuses a seq at or below a live voucher of the payer (it would be stepped over)', async () => {
    const { service, session, debt, open, sign } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);
    open.maxSeq = 9n;

    await expect(
      service.settle(session, debt.id, { voucher, signature: sign(voucher) }),
    ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_VOUCHER_SEQ_STALE });
  });

  it('refuses a debt that is not the session payer’s own', async () => {
    const { service, session, debt } = build();
    const other = { ...session, agentAccount: generateSigner(CHAIN).account };

    await expect(service.voucherIntent(other, debt.id)).rejects.toMatchObject({
      errorCode: PaymentErrorCode.PAYMENT_DEBT_NOT_FOUND,
    });
    await expect(service.voucherIntent(session, randomUUID())).rejects.toMatchObject({
      errorCode: PaymentErrorCode.PAYMENT_DEBT_NOT_FOUND,
    });
  });
});
