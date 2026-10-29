import 'reflect-metadata';
import { HEADERS_METADATA } from '@nestjs/common/constants';

import {
  PUBLIC_RECEIPT_SQL,
  PublicReceiptReadRepository,
  type PublicReceiptRow,
} from '@database/postgres/repositories/public-receipt-read.repository';
import { NotChargedReason } from '@modules/catalogue/domain/not-charged-reason';
import { collectionStateOf } from '@modules/payment/domain/collection';
import { ReceiptPrivacyController } from '@modules/account/controllers/receipt-privacy.controller';
import { ReceiptsController } from '@modules/verification/controllers/receipts.controller';
import { StageStatus, VerificationStage } from '@modules/verification/domain/stage';
import { VerificationErrors } from '@modules/verification/errors/verification.errors';
import { PublicReceiptsController } from '@modules/verification/public-receipt/public-receipt.controller';
import {
  PUBLIC_RECEIPT_KEYS,
  assertPublicReceiptShape,
} from '@modules/verification/public-receipt/public-receipt.guard';
import {
  cleanName,
  roundedToMinute,
  toPublicReceipt,
} from '@modules/verification/public-receipt/public-receipt.mapper';
import { PublicReceiptService } from '@modules/verification/public-receipt/public-receipt.service';
import { CACHE_HEADER_KEY, NO_CACHE_HEADER_KEY } from '@shared/decorators/cache-header.decorator';
import { HumanSessionGuard, SessionAuthGuard } from '@shared/auth';
import { AGENT_SCOPE_METADATA } from '@shared/auth/agent-scope';
import { PublicReadRateLimitInterceptor } from '@shared/interceptors/public-read-rate-limit.interceptor';

const TOOL = '11111111-1111-4111-8111-111111111111';
const PROVIDER = '22222222-2222-4222-8222-222222222222';
const INTENT = '33333333-3333-4333-8333-333333333333';
const ASSET = 'eip155:4663/erc20:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const names = {
  providerNames: new Map([[PROVIDER, 'Chainlook']]),
  toolNames: new Map([[TOOL, 'check_token_risk']]),
};

function row(over: Partial<PublicReceiptRow> = {}): PublicReceiptRow {
  return {
    status: 'SETTLED',
    classification: null,
    verificationVerdict: null,
    asset: ASSET,
    decimals: 6,
    priceAmount: '20000',
    toolId: TOOL,
    providerId: PROVIDER,
    hasHold: true,
    holdReleased: false,
    lapsed: false,
    collectionCause: null,
    createdAt: new Date('2026-10-29T14:51:37.912Z'),
    settledAt: new Date('2026-10-29T14:52:05.100Z'),
    sampleDisplay: '1 in 125 calls at this price',
    stages: [
      { stage: 'SCHEMA', status: 'PASSED' },
      { stage: 'DETERMINISTIC_RULES', status: 'PASSED' },
    ],
    ...over,
  };
}

describe('public receipt: the mapper', () => {
  it('a charged call shows the price, the stages and minute-rounded times', () => {
    const r = toPublicReceipt(row(), names);
    expect(r.status).toBe('CHARGED');
    expect(r.chargedPrice.amount).toBe('20000');
    expect(r.notCharged).toBeNull();
    expect(r.createdAt).toBe('2026-10-29T14:51:00.000Z');
    expect(r.settledAt).toBe('2026-10-29T14:52:00.000Z');
    expect(r.tool).toEqual({ id: TOOL, name: 'check_token_risk' });
    expect(r.provider).toEqual({ id: PROVIDER, name: 'Chainlook' });
    // Always the four stages in order; one that never ran reads "not reached", never a tick.
    expect(r.stages.map((s) => s.stage)).toEqual([
      VerificationStage.SCHEMA,
      VerificationStage.DETERMINISTIC_RULES,
      VerificationStage.CROSS_CHECK,
      VerificationStage.SEMANTIC,
    ]);
    expect(r.stages[2]).toMatchObject({ status: StageStatus.NOT_REACHED, label: 'not reached' });
    expect(() => assertPublicReceiptShape(r)).not.toThrow();
  });

  it('a refunded call is not charged, with the fixed reason sentence', () => {
    const r = toPublicReceipt(row({ status: 'REFUNDED' }), names);
    expect(r.status).toBe('NOT_CHARGED');
    expect(r.chargedPrice.amount).toBe('0');
    expect(r.notCharged?.reason).toBe(NotChargedReason.FAILED_CHECK);
    expect(r.notCharged?.text).toMatch(/failed our check/);
  });

  it('a forfeited or voided settled call is not charged; a written-off debt says nothing about why', () => {
    expect(toPublicReceipt(row({ collectionCause: 'FORFEITED' }), names).notCharged?.reason).toBe(
      NotChargedReason.NOT_COLLECTED,
    );
    expect(
      toPublicReceipt(row({ collectionCause: 'VOIDED_REFUND' }), names).notCharged?.reason,
    ).toBe(NotChargedReason.FAILED_CHECK);
    const writtenOff = toPublicReceipt(row({ collectionCause: 'WRITTEN_OFF' }), names);
    expect(writtenOff.status).toBe('CLOSED');
    expect(writtenOff.notCharged).toBeNull();
    expect(writtenOff.chargedPrice.amount).toBe('0');
  });

  it('a call in flight is in progress and charged nothing yet', () => {
    const r = toPublicReceipt(row({ status: 'VERIFYING', settledAt: null }), names);
    expect(r.status).toBe('IN_PROGRESS');
    expect(r.chargedPrice.amount).toBe('0');
    expect(r.settledAt).toBeNull();
  });

  it('a provider that is not on the public list is never named, and neither is its tool', () => {
    const r = toPublicReceipt(row({ providerId: '99999999-9999-4999-8999-999999999999' }), names);
    expect(r.provider).toBeNull();
    expect(r.tool).toBeNull();
  });

  it('cleans provider-written names and drops a sampling sentence with unexpected characters', () => {
    expect(cleanName('  Chain‮look​\n  ')).toBe('Chainlook');
    expect(cleanName('x'.repeat(500))).toHaveLength(80);
    const r = toPublicReceipt(row({ sampleDisplay: '1 in 125 <script>alert(1)</script>' }), {
      providerNames: new Map([[PROVIDER, 'Chain‮look']]),
      toolNames: new Map([[TOOL, 'tool\u0000name']]),
    });
    expect(r.sampling).toBeNull();
    expect(r.provider?.name).toBe('Chainlook');
    expect(r.tool?.name).toBe('toolname');
  });

  it('rounds down to the minute in UTC', () => {
    expect(roundedToMinute(new Date('2026-10-29T14:51:59.999Z'))).toBe('2026-10-29T14:51:00.000Z');
  });

  it('agrees with the one collection predicate every other receipt surface uses', () => {
    const cases: [PublicReceiptRow['collectionCause'], string][] = [
      ['FORFEITED', 'provider_forfeit:STAKE_BELOW_MINIMUM'],
      ['WRITTEN_OFF', 'uncollected:30_DAYS'],
      ['VOIDED_REFUND', 'voided:REFUND'],
      ['VOIDED_VOID', 'voided:VOID'],
    ];
    for (const [cause, realError] of cases) {
      const real = collectionStateOf({ redemptionLastError: realError });
      const viaLabel = toPublicReceipt(row({ collectionCause: cause }), names);
      const charged = real === 'NORMAL' || real === 'DEBT_OUTSTANDING';
      expect(viaLabel.status === 'CHARGED').toBe(charged);
    }
    // A lapsed voucher with its hold still open is a debt the buyer owes: charged.
    expect(toPublicReceipt(row({ lapsed: true, holdReleased: false }), names).status).toBe(
      'CHARGED',
    );
  });
});

describe('public receipt: the fence', () => {
  const CANARIES = [
    'CANARY-request-body',
    'CANARY-response-body',
    'CANARY-stage-detail',
    'CANARY-reason',
    'CANARY-agent-account',
    'CANARY-request-hash',
    'CANARY-redemption-error',
    'CANARY-tx-ref',
    'CANARY-credential',
    'CANARY-voucher-signature',
  ];

  it('nothing the row carries beyond the allowed fields reaches the response', () => {
    // A `SELECT *` slipping into the repository later would hand the mapper all of this.
    const leaky = {
      ...row(),
      request: CANARIES[0],
      response: CANARIES[1],
      reason: CANARIES[3],
      agentAccount: CANARIES[4],
      requestHash: CANARIES[5],
      redemptionLastError: CANARIES[6],
      redemptionTxRefs: [CANARIES[7]],
      credentialId: CANARIES[8],
      voucherSignature: CANARIES[9],
      stages: [
        { stage: 'SCHEMA', status: 'PASSED', detail: CANARIES[2], code: CANARIES[2], score: 1 },
        { stage: 'DETERMINISTIC_RULES', status: 'FAILED', detail: CANARIES[2] },
      ],
    } as unknown as PublicReceiptRow;
    const out = JSON.stringify(toPublicReceipt(leaky, names));
    for (const canary of CANARIES) expect(out).not.toContain(canary);
    expect(Object.keys(JSON.parse(out) as object).sort()).toEqual([...PUBLIC_RECEIPT_KEYS].sort());
  });

  it('the top-level key list is pinned: a new key must be a deliberate change here', () => {
    expect([...PUBLIC_RECEIPT_KEYS].sort()).toEqual(
      [
        'chargedPrice',
        'createdAt',
        'listedPrice',
        'notCharged',
        'provider',
        'sampling',
        'settledAt',
        'stages',
        'status',
        'tool',
      ].sort(),
    );
  });

  it('the guard refuses an unknown key at any depth, a wrong type, a bad enum and a hash-like string', () => {
    const ok = toPublicReceipt(row(), names);
    expect(() => assertPublicReceiptShape(ok)).not.toThrow();
    expect(() => assertPublicReceiptShape({ ...ok, extra: 1 })).toThrow(/key is not allowed/);
    expect(() =>
      assertPublicReceiptShape({ ...ok, listedPrice: { ...ok.listedPrice, wallet: 'x' } }),
    ).toThrow(/\.listedPrice\.wallet/);
    expect(() =>
      assertPublicReceiptShape({ ...ok, stages: ok.stages.map((s) => ({ ...s, detail: 'x' })) }),
    ).toThrow(/key is not allowed/);
    expect(() => assertPublicReceiptShape({ ...ok, status: 'PAID' })).toThrow(/allowed value/);
    expect(() => assertPublicReceiptShape({ ...ok, createdAt: 5 })).toThrow(/not a string/);
    expect(() =>
      assertPublicReceiptShape({ ...ok, provider: { id: PROVIDER, name: `0x${'a'.repeat(40)}` } }),
    ).toThrow(/address or a hash/);
    const missing: Record<string, unknown> = { ...ok };
    delete missing.stages;
    expect(() => assertPublicReceiptShape(missing)).toThrow(/key is missing/);
  });

  it('the SQL selects a fixed column list: no wildcard, no request or response, no wallet or signature columns', () => {
    const sql = PUBLIC_RECEIPT_SQL;
    expect(sql).not.toMatch(/\bSELECT\s+\*/i);
    expect(sql).not.toMatch(/\b[a-z]\.\*/i);
    for (const forbidden of [
      'r.request',
      'r.response',
      'agent_account',
      'request_hash',
      'voucher_',
      'redemption_tx_refs',
      'held_tx_ref',
      'status_reason',
      'credential_id',
      'idempotency_key',
      'last_error AS',
      'verifiers',
      'label_note',
    ]) {
      expect(sql).not.toContain(forbidden);
    }
    // The stage detail text is dropped inside the query: only stage and status are rebuilt.
    expect(sql).toContain(
      "jsonb_build_object('stage', s.e ->> 'stage', 'status', s.e ->> 'status')",
    );
    // A hidden organization and a free call are simply not found.
    expect(sql).toContain('o.receipts_public = true');
    expect(sql).toContain("i.call_class = 'PAID'");
  });

  it('the repository passes the id as a parameter, never into the SQL text', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repo = new PublicReceiptReadRepository({ query } as never);
    await repo.findPublicReceiptRow("x'; DROP TABLE payment_intents; --");
    expect(query).toHaveBeenCalledTimes(1);
    const [text, params] = query.mock.calls[0] as [string, string[]];
    expect(text).toBe(PUBLIC_RECEIPT_SQL);
    expect(text).not.toContain('DROP');
    expect(params[0]).toContain('DROP');
  });
});

describe('public receipt: the service', () => {
  const catalogue = {
    listProviders: jest
      .fn()
      .mockResolvedValue({ providers: [{ providerId: PROVIDER, name: 'Chainlook' }] }),
    listTools: jest.fn().mockResolvedValue({ tools: [{ id: TOOL, name: 'check_token_risk' }] }),
  };

  function service(found: PublicReceiptRow | null) {
    const reader = { findPublicReceiptRow: jest.fn().mockResolvedValue(found) };
    return { svc: new PublicReceiptService(reader as never, catalogue as never), reader };
  }

  it('a malformed id, an unknown id and a hidden receipt end in the same 404, and a malformed id never reaches the database', async () => {
    const bad = service(null);
    const missing = service(null);
    const errors = await Promise.all([
      bad.svc.read('not-a-uuid').catch((e: unknown) => e),
      missing.svc.read(INTENT).catch((e: unknown) => e),
    ]);
    expect(bad.reader.findPublicReceiptRow).not.toHaveBeenCalled();
    const wire = (e: unknown) => JSON.stringify((e as { toJSON(): unknown }).toJSON());
    const [a, b] = errors;
    expect((a as { statusCode: number }).statusCode).toBe(404);
    expect((b as { statusCode: number }).statusCode).toBe(404);
    expect(wire(a)).toBe(wire(b));
    expect(wire(a)).toBe(wire(VerificationErrors.receiptNotFound()));
    // The message does not echo the id, so it cannot tell a caller anything.
    expect(wire(a)).not.toContain(INTENT);
  });

  it('answers with the public shape for a found call', async () => {
    const { svc, reader } = service(row());
    const out = await svc.read(INTENT.toUpperCase());
    expect(reader.findPublicReceiptRow).toHaveBeenCalledWith(INTENT);
    expect(out.status).toBe('CHARGED');
  });

  it('fails closed when the mapper output breaks the shape: a generic error, nothing sent', async () => {
    const { svc } = service(row({ asset: `0x${'b'.repeat(64)}` }));
    await expect(svc.read(INTENT)).rejects.toThrow('Public receipt could not be produced');
  });
});

describe('public receipt: the routes', () => {
  it('the public route has its own short cache, no robots index and no referrer, and a rate limit', () => {
    const handler = PublicReceiptsController.prototype.get;
    const cache = Reflect.getMetadata(CACHE_HEADER_KEY, handler) as Record<string, number>;
    expect(cache).toMatchObject({
      maxAge: 30,
      cdnMaxAge: 30,
      staleWhileRevalidate: 0,
      cdnStaleWhileRevalidate: 0,
    });
    const headers = Reflect.getMetadata(HEADERS_METADATA, handler) as Array<{
      name: string;
      value: string;
    }>;
    expect(headers).toEqual(
      expect.arrayContaining([
        { name: 'X-Robots-Tag', value: 'noindex, nofollow' },
        { name: 'Referrer-Policy', value: 'no-referrer' },
      ]),
    );
    const interceptors = Reflect.getMetadata(
      '__interceptors__',
      PublicReceiptsController,
    ) as unknown[];
    expect(interceptors).toContain(PublicReadRateLimitInterceptor);
    expect(Reflect.getMetadata('path', PublicReceiptsController)).toBe('public/receipts');
  });

  it("the owner's receipt route is never stored by a shared cache", () => {
    expect(Reflect.getMetadata(NO_CACHE_HEADER_KEY, ReceiptsController.prototype.getReceipt)).toBe(
      true,
    );
  });

  it("the owner switch is a person's act: an agent credential is refused", () => {
    const guards = Reflect.getMetadata('__guards__', ReceiptPrivacyController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([SessionAuthGuard, HumanSessionGuard]));
    // No agent scope opens it either: no @RequireAgentScope on the class or the handlers.
    for (const target of [
      ReceiptPrivacyController,
      ReceiptPrivacyController.prototype.get,
      ReceiptPrivacyController.prototype.set,
    ]) {
      expect(Reflect.getMetadata(AGENT_SCOPE_METADATA, target)).toBeUndefined();
    }
  });
});
