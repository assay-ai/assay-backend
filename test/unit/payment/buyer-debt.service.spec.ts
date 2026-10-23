import { randomUUID } from 'node:crypto';

import { QueryFailedError } from 'typeorm';

import {
  LapsedVoucherReplacement,
  OpenVoucherTotals,
  OutstandingDebt,
  VoucherAdmissionScope,
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

/** A chain on which nobody is anybody's delegate, but for the ones a test grants. */
class FakeEvmChain {
  readonly delegates = new Set<string>();

  async readContract(args: { functionName: string; args?: unknown[] }): Promise<unknown> {
    if (args.functionName === 'delegationOf') {
      const delegate = String(args.args?.[1] ?? '').toLowerCase();
      if (this.delegates.has(delegate)) {
        return {
          maxVoucherAmount: 10_000_000n,
          maxPerWindow: 100_000_000n,
          spentInWindow: 0n,
          windowStartedAt: 0n,
          validUntil: BigInt(Math.floor(Date.now() / 1000) + 86_400),
          listPosition: 1,
          revoked: false,
        };
      }
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
  const chain = new FakeEvmChain();
  const adapter = new EvmChainAdapter(
    new Map([[CHAIN, chain as never]]),
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

  const agentId = randomUUID();
  const debt: OutstandingDebt = {
    id: randomUUID(),
    organizationId,
    agentId,
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
    voucherResource: null,
    lapsedAt: new Date('2026-10-16T00:00:00Z'),
    expiresAt: new Date('2026-10-15T23:55:00Z'),
    cause: 'DelegateIsRevoked',
    replacedAt: null,
    writtenOff: false,
    createdAt: new Date('2026-10-15T23:55:00Z'),
  };
  const debts: OutstandingDebt[] = [debt];
  const replaced: Array<{
    id: string;
    replacement: LapsedVoucherReplacement;
    scope: VoucherAdmissionScope;
    reopenHoldId: string | null;
  }> = [];
  const open: { -readonly [K in keyof OpenVoucherTotals]: OpenVoucherTotals[K] } = {
    escrow: 0n,
    delegate: 0n,
    pausedFor: null,
    nextSeq: 100n,
    maxSeq: 2n,
  };
  const payments = {
    findOutstandingDebts: jest.fn(async () => [...debts]),
    findOutstandingDebt: jest.fn(
      async (payer: string, id: string) =>
        debts.find((d) => d.id === id && d.agentAccount === payer) ?? null,
    ),
    replaceLapsedVoucher: jest.fn(
      async (
        _org: string,
        id: string,
        _payer: string,
        replacement: LapsedVoucherReplacement,
        admission: { scope: VoucherAdmissionScope; admit: (o: OpenVoucherTotals) => void },
        reopenHoldId: string | null,
      ) => {
        admission.admit(open);
        replaced.push({ id, replacement, scope: admission.scope, reopenHoldId });
        const index = debts.findIndex((d) => d.id === id);
        debts[index] = { ...debts[index], replacedAt: new Date(), writtenOff: false };
        return true;
      },
    ),
  };
  const intents = {
    reopenDebtHold: jest.fn(async () => 'hold-reopened'),
    releaseUnusedHold: jest.fn(async () => undefined),
  };
  const spendPolicy = { assertReplacementAllowed: jest.fn(async () => undefined) };
  const rateLimiter = { take: jest.fn(async () => ({ allowed: true })) };
  const escrow = {
    read: jest.fn(async () => escrowReading()),
    escrowAddresses: jest.fn(async () => ({ escrowPda: ESCROW, escrowTokenAccount: ESCROW })),
  };
  const tools = {
    findTool: jest.fn(async () => ({ id: TOOL_ID, name: 'get_weather' })),
  };
  const service = new BuyerDebtService(
    payments as never,
    intents as never,
    vouchers,
    seqService as unknown as EscrowSeqService,
    chains,
    escrow as never,
    tools as never,
    spendPolicy as never,
    rateLimiter as never,
  );
  const session: McpSession = {
    organizationId,
    agentId,
    agentAccount: payer.account,
    chainId: CHAIN,
    credentialId: 'human',
    callerKind: McpCallerKind.HUMAN,
  } as unknown as McpSession;
  const sign = (voucher: Voucher, signer: EvmSigner = payer) =>
    signer.sign(adapter.buildVoucherMessage(voucher));
  return {
    service,
    payments,
    intents,
    spendPolicy,
    rateLimiter,
    tools,
    debt,
    debts,
    replaced,
    open,
    session,
    sign,
    payer,
    adapter,
    chain,
  };
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
        state: 'OPEN',
        lapsedAt: '2026-10-16T00:00:00.000Z',
        writeOffAt: '2026-11-15T00:00:00.000Z',
        // expiresAt + 1,800 s grace + 120 s skew.
        replaceableAt: '2026-10-16T00:27:00.000Z',
        replacedAt: null,
      }),
    ]);
  });

  it('BUG-R17f-01: refuses a debt whose voucher is still inside its on-chain window, before any seq', async () => {
    const { service, session, debt, debts, payments } = build();
    // Lapsed early (a permanent refusal): the old voucher stays redeemable
    // until expiresAt + grace, so a replacement could be charged on top of it.
    const expiresAt = new Date(Date.now() - 60_000);
    debts[0] = { ...debt, expiresAt };
    const allocate = (service as unknown as { seqs: { allocate: jest.Mock } }).seqs.allocate;

    await expect(service.voucherIntent(session, debt.id)).rejects.toMatchObject({
      errorCode: PaymentErrorCode.PAYMENT_DEBT_NOT_YET_REPLACEABLE,
      statusCode: 409,
    });
    expect(allocate).not.toHaveBeenCalled();
    const [listed] = await service.list(session);
    expect(listed.replaceableAt).toBe(new Date(expiresAt.getTime() + 1_920_000).toISOString());
    expect(payments.replaceLapsedVoucher).not.toHaveBeenCalled();
  });

  it('BUG-R17f-01: a database refusal of the replacement is a 409, not a 500, and gives the hold back', async () => {
    const { service, session, debt, debts, payments, intents, sign } = build();
    debts[0] = { ...debt, writtenOff: true, cause: 'uncollected:VoucherExpired' };
    const { voucher } = await service.voucherIntent(session, debt.id);
    payments.replaceLapsedVoucher.mockRejectedValueOnce(
      new QueryFailedError('UPDATE "payment_intents" …', [], {
        code: '23514',
        message: 'payment_intents.voucher_seq is immutable',
      } as unknown as Error),
    );

    await expect(
      service.settle(session, debt.id, { voucher, signature: sign(voucher) }),
    ).rejects.toMatchObject({
      errorCode: PaymentErrorCode.PAYMENT_DEBT_REPLACEMENT_REFUSED,
      statusCode: 409,
    });
    expect(intents.releaseUnusedHold).toHaveBeenCalledWith(debt.organizationId, 'hold-reopened');
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
          resource: '/mcp/tools/get_weather',
        }),
        // The same admission scope a new voucher of this payer gets (M4).
        scope: expect.objectContaining({ payer: session.agentAccount, assetId: USDG }),
        reopenHoldId: null,
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

  it('admits a seq below a live voucher of the payer: eip155 redeems any order (D-23)', async () => {
    const { service, session, debt, open, sign, replaced } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);
    open.maxSeq = BigInt(voucher.seq) + 5n;

    await service.settle(session, debt.id, { voucher, signature: sign(voucher) });
    expect(replaced).toHaveLength(1);
  });

  it('still refuses the very seq a live voucher of the payer carries, as a replay', async () => {
    const { service, session, debt, open, sign, replaced } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);
    open.maxSeq = BigInt(voucher.seq);

    await expect(
      service.settle(session, debt.id, { voucher, signature: sign(voucher) }),
    ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_VOUCHER_SEQ_ALREADY_USED });
    expect(replaced).toEqual([]);
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

  it('M4: refuses a replacement that does not fit the escrow window, and changes nothing', async () => {
    const { service, session, debt, open, sign, debts } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);
    // The payer's other vouchers in flight already fill the escrow's window.
    open.escrow = 10_000_000n;

    await expect(
      service.settle(session, debt.id, { voucher, signature: sign(voucher) }),
    ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED });
    expect(debts[0].replacedAt).toBeNull();
  });

  it("M4: refuses a replacement while the payer's admission is paused", async () => {
    const { service, session, debt, open, sign } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);
    open.pausedFor = 30;

    await expect(
      service.settle(session, debt.id, { voucher, signature: sign(voucher) }),
    ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_VOUCHER_ADMISSION_PAUSED });
  });

  it('M4: a debt being collected is REPLACING, still listed, and cannot be re-signed', async () => {
    const { service, session, debt, sign } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);
    await service.settle(session, debt.id, { voucher, signature: sign(voucher) });

    const [listed] = await service.list(session);
    expect(listed).toMatchObject({ intentId: debt.id, state: 'REPLACING' });
    expect(listed.replacedAt).not.toBeNull();
    // The write-off clock is the first lapse, unchanged.
    expect(listed.writeOffAt).toBe('2026-11-15T00:00:00.000Z');
    await expect(service.voucherIntent(session, debt.id)).rejects.toMatchObject({
      errorCode: PaymentErrorCode.PAYMENT_DEBT_REPLACEMENT_PENDING,
    });
  });

  it("M4: a delegate signs only its own agent's debt, within its spend policy", async () => {
    const { service, session, debt, chain, spendPolicy, replaced, debts } = build();
    const delegate = generateSigner(CHAIN);
    chain.delegates.add(delegate.address.toLowerCase());
    const agentSession = {
      ...session,
      callerKind: McpCallerKind.AGENT,
      delegateAccount: delegate.account,
    } as McpSession;
    const { voucher } = await service.voucherIntent(agentSession, debt.id);
    const { adapter } = build();
    const signature = delegate.sign(adapter.buildVoucherMessage(voucher));

    // Another agent's credential of the same payer: refused, nothing changed.
    await expect(
      service.settle({ ...agentSession, agentId: randomUUID() }, debt.id, { voucher, signature }),
    ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_DEBT_NOT_FOUND });
    expect(replaced).toEqual([]);

    // The agent's own debt: its spend policy is asked, then it is replaced.
    await service.settle(agentSession, debt.id, { voucher, signature });
    expect(spendPolicy.assertReplacementAllowed).toHaveBeenCalledWith({
      organizationId: session.organizationId,
      agentId: session.agentId,
      price: MoneyUtil.of('50000', USDG, 6),
    });
    expect(replaced[0].replacement.delegate?.toLowerCase()).toBe(delegate.account.toLowerCase());
    expect(debts[0].replacedAt).not.toBeNull();
  });

  it('H1: a written-off debt is listed, and re-signing it opens a new hold for the provider', async () => {
    const { service, session, debt, debts, intents, replaced, sign } = build();
    debts[0] = { ...debt, writtenOff: true, cause: 'uncollected:DelegateIsRevoked' };

    const [listed] = await service.list(session);
    expect(listed.state).toBe('WRITTEN_OFF');

    const { voucher } = await service.voucherIntent(session, debt.id);
    await service.settle(session, debt.id, { voucher, signature: sign(voucher) });

    expect(intents.reopenDebtHold).toHaveBeenCalledWith(expect.objectContaining({ id: debt.id }));
    expect(replaced[0].reopenHoldId).toBe('hold-reopened');
  });

  it('H1: a refused re-sign of a written-off debt gives the new hold back', async () => {
    const { service, session, debt, debts, intents, open, sign } = build();
    debts[0] = { ...debt, writtenOff: true, cause: 'uncollected:VoucherExpired' };
    const { voucher } = await service.voucherIntent(session, debt.id);
    open.maxSeq = BigInt(voucher.seq);

    await expect(
      service.settle(session, debt.id, { voucher, signature: sign(voucher) }),
    ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_VOUCHER_SEQ_ALREADY_USED });
    expect(intents.releaseUnusedHold).toHaveBeenCalledWith(debt.organizationId, 'hold-reopened');
  });

  it('L5: a debt whose tool is gone is still settleable — the stored resource is used', async () => {
    const { service, session, debt, debts, tools, sign, replaced } = build();
    debts[0] = { ...debt, voucherResource: '/mcp/tools/old_name' };
    tools.findTool.mockResolvedValue(null as never);

    const { voucher } = await service.voucherIntent(session, debt.id);
    expect(voucher.resource).toBe('/mcp/tools/old_name');
    await service.settle(session, debt.id, { voucher, signature: sign(voucher) });
    expect(replaced[0].replacement.resource).toBe('/mcp/tools/old_name');
  });

  it('L5: an older debt whose tool is gone takes a resource that hashes to the signed one', async () => {
    const { service, session, debt, debts, tools, adapter } = build();
    debts[0] = { ...debt, voucherResourceHash: adapter.voucherResourceHash('/mcp/tools/gone') };
    tools.findTool.mockResolvedValue(null as never);

    await expect(service.voucherIntent(session, debt.id)).rejects.toMatchObject({
      errorCode: PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
    });
    const { voucher } = await service.voucherIntent(session, debt.id, '/mcp/tools/gone');
    expect(voucher.resource).toBe('/mcp/tools/gone');
  });

  it('L5: reads the debt by id, not out of the first page of debts', async () => {
    const { service, session, debt, payments } = build();
    await service.voucherIntent(session, debt.id);
    expect(payments.findOutstandingDebt).toHaveBeenCalledWith(session.agentAccount, debt.id);
  });

  it('L6: a seq held by another row is a 409 replay, not a 500', async () => {
    const { service, session, debt, payments, sign } = build();
    const { voucher } = await service.voucherIntent(session, debt.id);
    payments.replaceLapsedVoucher.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );

    await expect(
      service.settle(session, debt.id, { voucher, signature: sign(voucher) }),
    ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_VOUCHER_SEQ_ALREADY_USED });
  });

  it('L7: voucher-intent is throttled with the next-seq budget, before any seq is allocated', async () => {
    const { service, session, debt, rateLimiter } = build();
    rateLimiter.take.mockResolvedValueOnce({ allowed: false, reason: 'address' } as never);

    await expect(service.voucherIntent(session, debt.id)).rejects.toMatchObject({
      errorCode: PaymentErrorCode.PAYMENT_NEXT_SEQ_RATE_LIMITED,
    });
    expect(rateLimiter.take).toHaveBeenCalledWith(`credential:${session.credentialId}`);
  });
});
