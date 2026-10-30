import { DataSource } from 'typeorm';

import { OverrideLogEntryEntity } from '@database/postgres/entities/override-log-entry.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  OperatorDebtFilter,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import {
  ApprovalMode,
  lookupOverride,
  OperatorRole,
} from '@modules/operator/domain/override-register';
import { ApprovalQueuedDto } from '@modules/operator/dto/operator-approval.dto';
import {
  BuyerDebtVoidResultDto,
  ListOperatorBuyerDebtsQueryDto,
} from '@modules/operator/dto/operator-buyer-debts.dto';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OperatorApprovalService } from '@modules/operator/services/operator-approval.service';
import {
  DEBT_VOID_APPROVAL_ACTION,
  OperatorBuyerDebtService,
  suggestsPlatformCause,
} from '@modules/operator/services/operator-buyer-debt.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { UsedSeqRecord } from '@modules/payment/ports/voucher-redeemer.port';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from '../provider/helpers/fake-query-builder';

/**
 * `M-1`, owner decision 2026-10-30: nothing voids a buyer debt automatically.
 * An operator lists open debts, requests a void of exact ids with a reason,
 * and a SECOND operator approves exactly that list; on approval each id is
 * re-checked (still a debt, its eip155 seq unused on chain) before
 * `PaymentIntentService.voidDebt`.
 */

const EVM_USDC = 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const SOL_USDC =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAYER = 'eip155:42161:0x1111111111111111111111111111111111111111';
const PAYEE = 'eip155:42161:0x2222222222222222222222222222222222222222';
const REASON = 'Redeemer was unfunded from 10:00 to 12:00 UTC; incident INC-42.';

const ids = {
  a: '00000000-0000-4000-8000-00000000000a',
  b: '00000000-0000-4000-8000-00000000000b',
  c: '00000000-0000-4000-8000-00000000000c',
  d: '00000000-0000-4000-8000-00000000000d',
  e: '00000000-0000-4000-8000-00000000000e',
};

const operator = (id: string, roles: OperatorRole[]): OperatorSession => ({
  operatorId: id,
  subject: `${id}@`,
  displayName: id,
  email: `${id}@example.test`,
  roles,
  authorityLimitMinor: null,
});
const TRE = operator('op-tre', [OperatorRole.TRE]);
const LEAD = operator('op-adjl', [OperatorRole.ADJL]);
const SRE = operator('op-sre', [OperatorRole.SRE]);
const POLA = operator('op-pola', [OperatorRole.POLA]);

function debt(id: string, patch: Partial<PaymentIntentEntity> = {}): PaymentIntentEntity {
  return {
    id,
    organizationId: `org-${id.slice(-1)}`,
    agentAccount: PAYER,
    providerId: 'prov-1',
    providerAccount: PAYEE,
    chainId: 'eip155:42161',
    assetId: EVM_USDC,
    decimals: 6,
    priceAmount: '1000000',
    requestHash: 'cd'.repeat(32),
    voucherSeq: '7',
    voucherSignature: `0x${'ab'.repeat(65)}`,
    voucherResourceHash: `sha256:${'ef'.repeat(32)}`,
    voucherIssuedAt: '1800000000',
    voucherDelegate: null,
    expiresAt: new Date(1_800_000_300_000),
    createdAt: new Date('2026-10-29T10:00:00Z'),
    redemptionLapsedAt: new Date('2026-10-29T12:10:00Z'),
    redemptionLastError: 'VoucherExpired',
    ...patch,
  } as PaymentIntentEntity;
}

function build(options: {
  debts: PaymentIntentEntity[];
  records?: Record<string, UsedSeqRecord | Error>;
  voidDebt?: (org: string, id: string) => boolean;
}) {
  // The open debts as the database holds them; `voidDebt` closes one.
  const open = new Map(options.debts.map((row) => [row.id, row]));
  const runner = {
    connect: async () => undefined,
    startTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    release: async () => undefined,
  };
  const entries: Partial<OverrideLogEntryEntity>[] = [];
  const markApproved = jest.fn(async () => true);
  const overrides = new OverrideLogService(
    { createQueryRunner: () => runner } as never,
    {
      append: async (_r: unknown, entry: Partial<OverrideLogEntryEntity>) => {
        entries.push(entry);
        return entry;
      },
    } as never,
    { markApproved } as never,
  );

  const stored = new Map<string, Record<string, unknown>>();
  const approvals = new OperatorApprovalService(
    {
      create: (row: Record<string, unknown>) => row,
      save: async (row: Record<string, unknown>) => {
        const saved = { ...row, id: `appr-${stored.size + 1}`, createdAt: new Date() };
        stored.set(saved.id, saved);
        return saved;
      },
      expireStale: async () => 0,
      findOneBy: async ({ id }: { id: string }) => stored.get(id) ?? null,
      find: async () => [],
    } as never,
    { findById: async (id: string) => ({ subject: `${id}@` }) } as never,
    {
      requireActive: async (id: string) => [TRE, LEAD, SRE].find((op) => op.operatorId === id),
      sessionOf: (op: OperatorSession) => op,
    } as never,
  );

  const listQb = fakeQueryBuilder(options.debts);
  const filters: OperatorDebtFilter[] = [];
  const payments = {
    operatorDebtsQuery: jest.fn((filter: OperatorDebtFilter) => {
      filters.push(filter);
      return listQb.qb;
    }),
    operatorDebtTotals: jest.fn(async () => [
      { assetId: EVM_USDC, decimals: 6, count: 3, amount: '3000000' },
      { assetId: SOL_USDC, decimals: 6, count: 1, amount: '500000' },
    ]),
    findOperatorDebts: jest.fn(async (wanted: readonly string[]) =>
      wanted.map((id) => open.get(id)).filter((row): row is PaymentIntentEntity => !!row),
    ),
  };
  const intents = {
    voidDebt: jest.fn(async (org: string, id: string, _outcome: string) => {
      const ok = options.voidDebt ? options.voidDebt(org, id) : true;
      if (ok) open.delete(id);
      return ok;
    }),
  };
  const redeemer = {
    usedSeqRecord: jest.fn(async (request: { seq: string; payer: string }) => {
      const answer = options.records?.[request.seq] ?? 'NONE';
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
  const service = new OperatorBuyerDebtService(
    payments as never,
    intents as never,
    redeemer as never,
    overrides,
    approvals,
  );
  return {
    service,
    approvals,
    payments,
    intents,
    redeemer,
    entries,
    stored,
    filters,
    listQb,
    open,
  };
}

const approverOf = (who: OperatorSession) => who;

describe('M-1 in the register', () => {
  it('is TWO_PERSON, money family, TRE/ADJL as maker and checker, and irreversible', () => {
    expect(lookupOverride('M-1')).toMatchObject({
      family: 'M',
      approval: ApprovalMode.TWO_PERSON,
      roles: [OperatorRole.TRE, OperatorRole.ADJL],
      approverRoles: [OperatorRole.TRE, OperatorRole.ADJL],
      reversible: false,
      implemented: true,
    });
  });
});

describe('OperatorBuyerDebtService.list', () => {
  it('passes every filter through, pages the debts and returns the totals of all of them', async () => {
    const rows = [
      debt(ids.a),
      debt(ids.b, { redemptionLastError: 'uncollected:UNKNOWN_REVERT:none' }),
      debt(ids.c, { redemptionLastError: 'EscrowInsufficient' }),
    ];
    const { service, filters, listQb } = build({ debts: rows });
    const query = Object.assign(new ListOperatorBuyerDebtsQueryDto(), {
      limit: 25,
      chainId: 'eip155:42161',
      assetId: EVM_USDC,
      payerAccount: PAYER,
      buyerOrganizationId: '11111111-1111-4111-8111-111111111111',
      providerId: '22222222-2222-4222-8222-222222222222',
      lastError: 'VoucherExpired',
      suggestedOnly: true,
      from: new Date('2026-10-29T00:00:00Z'),
      to: new Date('2026-10-30T00:00:00Z'),
    });

    const page = await service.list(query);

    // The same filter for the page and the totals.
    expect(filters).toHaveLength(2);
    expect(filters[0]).toEqual({
      chainId: 'eip155:42161',
      assetId: EVM_USDC,
      payerAccount: PAYER,
      buyerOrganizationId: '11111111-1111-4111-8111-111111111111',
      providerId: '22222222-2222-4222-8222-222222222222',
      lastError: 'VoucherExpired',
      suggestedOnly: true,
    });
    // The lapse-time range bounds the lapse column, newest lapse first.
    const sql = listQb.wheres.map((w) => w.sql).join(' ');
    expect(sql).toContain('intent.redemption_lapsed_at >= :__from');
    expect(sql).toContain('intent.redemption_lapsed_at < :__to');
    expect(listQb.orders[0]).toEqual(['intent.redemption_lapsed_at', 'DESC']);

    expect(page.items.map((item) => item.intentId)).toEqual([ids.a, ids.b, ids.c]);
    expect(page.items.map((item) => item.suggestedPlatformCause)).toEqual([true, true, false]);
    expect(page.items[1]).toMatchObject({
      writtenOff: true,
      lastError: 'UNKNOWN_REVERT:none',
      buyerOrganizationId: `org-b`,
      amount: '1000000',
    });
    expect(page.totals).toEqual({
      count: 4,
      byAsset: [
        { assetId: EVM_USDC, decimals: 6, count: 3, amount: '3000000' },
        { assetId: SOL_USDC, decimals: 6, count: 1, amount: '500000' },
      ],
    });
    expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
  });

  it.each([
    ['VoucherExpired', true],
    ['UNKNOWN_REVERT:0xdeadbeef', true],
    ['FeeSpikeDeferred', true],
    ['uncollected:VoucherExpired', true],
    ['EscrowInsufficient', false],
    ['DelegateIsRevoked', false],
    ['unknown', false],
    [null, false],
  ])('labels %s as suggestedPlatformCause=%s (informational only)', (cause, expected) => {
    expect(suggestsPlatformCause(cause)).toBe(expected);
  });
});

describe('PaymentIntentRepository.operatorDebtsQuery', () => {
  async function repository(): Promise<PaymentIntentRepository> {
    const dataSource = new DataSource({ type: 'postgres', entities: [PaymentIntentEntity] });
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    return new PaymentIntentRepository(dataSource);
  }

  it('reads only open buyer debts, across organizations, with each filter bound', async () => {
    const repo = await repository();
    const [sql, params] = repo
      .operatorDebtsQuery({
        chainId: 'eip155:42161',
        assetId: EVM_USDC,
        payerAccount: PAYER,
        buyerOrganizationId: 'org-x',
        providerId: 'prov-x',
        lastError: 'VoucherExpired',
        suggestedOnly: true,
      })
      .getQueryAndParameters();

    expect(sql).toContain('"intent"."organization_id" IS NOT NULL');
    expect(sql).toContain(`"intent"."status" = 'SETTLED' AND "intent"."rail" = 'RAIL_B_VOUCHER'`);
    expect(sql).toContain('"intent"."redemption_lapsed_at" IS NOT NULL');
    expect(sql).toContain('"intent"."redemption_replaced_at" IS NULL');
    expect(sql).toContain(
      `("intent"."hold_released_at" IS NULL OR "intent"."redemption_last_error" LIKE 'uncollected:%')`,
    );
    expect(sql).toContain("LIKE 'UNKNOWN\\_REVERT:%'");
    expect(params).toEqual(
      expect.arrayContaining([
        'eip155:42161',
        EVM_USDC,
        PAYER,
        'org-x',
        'prov-x',
        'VoucherExpired',
      ]),
    );
  });

  it('with no filter adds no filter', async () => {
    const repo = await repository();
    const [sql, params] = repo.operatorDebtsQuery({}).getQueryAndParameters();
    expect(params).toEqual([]);
    expect(sql).not.toContain('UNKNOWN');
  });
});

describe('OperatorBuyerDebtService.requestVoid — always a second operator', () => {
  it('queues the request, pinning the exact sorted ids, the asset and the total; voids nothing', async () => {
    const { service, intents, entries, stored } = build({
      debts: [debt(ids.b), debt(ids.a, { priceAmount: '2500000' })],
    });

    const queued = await service.requestVoid({
      operator: TRE,
      intentIds: [ids.b, ids.a, ids.b],
      reason: REASON,
      ticketRef: 'INC-42',
    });

    expect(queued).toBeInstanceOf(ApprovalQueuedDto);
    expect(queued.action).toBe(DEBT_VOID_APPROVAL_ACTION);
    expect(stored.get(queued.approvalId)).toMatchObject({
      requestedBy: TRE.operatorId,
      status: 'PENDING',
      payload: {
        intentIds: [ids.a, ids.b],
        assetId: EVM_USDC,
        decimals: 6,
        count: 2,
        totalAmount: '3500000',
        reason: REASON,
        ticketRef: 'INC-42',
      },
    });
    expect(intents.voidDebt).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });

  it('queues even a single small debt: two-person whatever the amount', async () => {
    const { service, intents } = build({ debts: [debt(ids.a, { priceAmount: '1' })] });
    const queued = await service.requestVoid({
      operator: LEAD,
      intentIds: [ids.a],
      reason: REASON,
    });
    expect(queued).toBeInstanceOf(ApprovalQueuedDto);
    expect(intents.voidDebt).not.toHaveBeenCalled();
  });

  it('refuses ids that are not open debts, naming them', async () => {
    const { service, stored } = build({ debts: [debt(ids.a)] });
    await expectErrorCodeAsync(
      () => service.requestVoid({ operator: TRE, intentIds: [ids.a, ids.c], reason: REASON }),
      'OPERATOR_DEBT_VOID_INVALID',
    );
    expect(stored.size).toBe(0);
  });

  it('refuses ids of more than one asset', async () => {
    const { service } = build({ debts: [debt(ids.a), debt(ids.b, { assetId: SOL_USDC })] });
    await expectErrorCodeAsync(
      () => service.requestVoid({ operator: TRE, intentIds: [ids.a, ids.b], reason: REASON }),
      'OPERATOR_DEBT_VOID_INVALID',
    );
  });

  it('refuses a requester without TRE or ADJL before queueing', async () => {
    const { service, stored } = build({ debts: [debt(ids.a)] });
    await expectErrorCodeAsync(
      () => service.requestVoid({ operator: SRE, intentIds: [ids.a], reason: REASON }),
      'OPERATOR_ROLE_REQUIRED',
    );
    expect(stored.size).toBe(0);
  });

  it('refuses a self-approval and voids nothing', async () => {
    const { service, approvals, intents, entries } = build({ debts: [debt(ids.a)] });
    const queued = await service.requestVoid({ operator: TRE, intentIds: [ids.a], reason: REASON });

    await expectErrorCodeAsync(
      () => approvals.approve(queued.approvalId, approverOf(TRE), null),
      'OPERATOR_SELF_APPROVAL_REFUSED',
    );
    expect(intents.voidDebt).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });

  it('refuses an approver who holds neither TRE nor ADJL', async () => {
    const { service, approvals, intents } = build({ debts: [debt(ids.a)] });
    const queued = await service.requestVoid({ operator: TRE, intentIds: [ids.a], reason: REASON });

    await expectErrorCodeAsync(
      () => approvals.approve(queued.approvalId, approverOf(POLA), null),
      'OPERATOR_APPROVER_ROLE_REQUIRED',
    );
    expect(intents.voidDebt).not.toHaveBeenCalled();
  });
});

describe('OperatorBuyerDebtService — on approval', () => {
  it('voids only the eligible ids and returns the others with their reasons', async () => {
    const { service, approvals, intents, open, redeemer, entries } = build({
      debts: [
        debt(ids.a, { voucherSeq: '1' }),
        debt(ids.b, { voucherSeq: '2' }),
        debt(ids.c, { voucherSeq: '3' }),
        debt(ids.d, { voucherSeq: '4' }),
        debt(ids.e, { voucherSeq: '5' }),
      ],
      records: { '2': 'HELD', '3': new Error('rpc down') },
      voidDebt: (_org, id) => id !== ids.e,
    });
    const queued = await service.requestVoid({
      operator: TRE,
      intentIds: [ids.a, ids.b, ids.c, ids.d, ids.e],
      reason: REASON,
    });
    // Settled by the buyer's replacement between the request and the approval.
    open.delete(ids.d);

    const decision = await approvals.approve(queued.approvalId, approverOf(LEAD), 'req-1');
    const result = decision.result as BuyerDebtVoidResultDto;

    expect(result.items).toEqual([
      { intentId: ids.a, result: 'VOIDED', skipReason: null },
      { intentId: ids.b, result: 'SKIPPED', skipReason: 'SEQ_USED_ON_CHAIN' },
      { intentId: ids.c, result: 'SKIPPED', skipReason: 'CHAIN_UNREADABLE' },
      { intentId: ids.d, result: 'SKIPPED', skipReason: 'NOT_A_DEBT' },
      { intentId: ids.e, result: 'SKIPPED', skipReason: 'CHANGED_UNDERNEATH' },
    ]);
    expect(result).toMatchObject({
      approvalId: queued.approvalId,
      assetId: EVM_USDC,
      requestedCount: 5,
      requestedAmount: '5000000',
      voidedCount: 1,
      voidedAmount: '1000000',
    });
    expect(intents.voidDebt).toHaveBeenCalledWith('org-a', ids.a, 'OPERATOR_PLATFORM_FAULT');
    expect(intents.voidDebt).not.toHaveBeenCalledWith(expect.anything(), ids.b, expect.anything());
    expect(intents.voidDebt).not.toHaveBeenCalledWith(expect.anything(), ids.c, expect.anything());
    expect(intents.voidDebt).not.toHaveBeenCalledWith(expect.anything(), ids.d, expect.anything());
    // The chain was asked about every debt still open.
    expect(redeemer.usedSeqRecord).toHaveBeenCalledTimes(4);

    // One register entry: requester, approver, reason, the ids and the total.
    expect(entries).toEqual([
      expect.objectContaining({
        code: 'M-1',
        family: 'M',
        action: 'buyer_debt.bulk_voided',
        actorOperatorId: TRE.operatorId,
        approverOperatorId: LEAD.operatorId,
        approvalMode: ApprovalMode.TWO_PERSON,
        reasonCode: 'PLATFORM_FAULT',
        reason: REASON,
        organizationId: null,
        requestId: 'req-1',
        before: expect.objectContaining({
          intentIds: [ids.a, ids.b, ids.c, ids.d, ids.e],
          assetId: EVM_USDC,
          count: 5,
          totalAmount: '5000000',
        }),
      }),
    ]);
  });

  it.each(['HELD', 'COLLECTED', 'REFUNDED', 'MISMATCH'] as const)(
    'never voids a seq the chain has used (%s)',
    async (record) => {
      const { service, approvals, intents } = build({
        debts: [debt(ids.a)],
        records: { '7': record },
      });
      const queued = await service.requestVoid({
        operator: LEAD,
        intentIds: [ids.a],
        reason: REASON,
      });

      const decision = await approvals.approve(queued.approvalId, approverOf(TRE), null);

      expect((decision.result as BuyerDebtVoidResultDto).items[0]).toMatchObject({
        result: 'SKIPPED',
        skipReason: 'SEQ_USED_ON_CHAIN',
      });
      expect(intents.voidDebt).not.toHaveBeenCalled();
    },
  );

  it('does not read the chain for a non-eip155 debt (Solana keeps no per-seq record)', async () => {
    const { service, approvals, intents, redeemer } = build({
      debts: [
        debt(ids.a, { chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', assetId: SOL_USDC }),
      ],
    });
    const queued = await service.requestVoid({ operator: TRE, intentIds: [ids.a], reason: REASON });

    await approvals.approve(queued.approvalId, approverOf(LEAD), null);

    expect(redeemer.usedSeqRecord).not.toHaveBeenCalled();
    expect(intents.voidDebt).toHaveBeenCalledTimes(1);
  });
});
