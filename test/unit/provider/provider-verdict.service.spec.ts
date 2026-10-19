import { EvidenceBodyEntity } from '@database/postgres/entities/evidence-body.entity';
import { EvidencePackEntity } from '@database/postgres/entities/evidence-pack.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { SlaWindowCallEntity } from '@database/postgres/entities/sla-window-call.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { EvidencePackRepository } from '@database/postgres/repositories/evidence-pack.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { VerifierOutcome } from '@modules/verification/domain/aggregation';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import { GetVerdictParamsDto } from '@modules/verification/dto/get-verdict.dto';
import { ListProviderVerdictsQueryDto } from '@modules/provider/dto/provider-verdict.dto';
import { ProviderVerdictService } from '@modules/provider/services/provider-verdict.service';
import { SortDirection } from '@shared/api';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

const PROVIDER = 'org-33333333-3333-4333-8333-333333333333';

function listQuery(
  overrides: Partial<ListProviderVerdictsQueryDto> = {},
): ListProviderVerdictsQueryDto {
  return Object.assign(
    new ListProviderVerdictsQueryDto(),
    { limit: 25, order: SortDirection.DESC },
    overrides,
  );
}

function buildRecord(overrides: Partial<VerificationRecordEntity> = {}): VerificationRecordEntity {
  return {
    id: 'record-1',
    organizationId: 'org-buyer-1',
    intentId: 'intent-1',
    toolId: 'tool-1',
    providerId: PROVIDER,
    state: 'JUDGED',
    request: null,
    response: null,
    outputSchema: null,
    verdictStatus: null,
    reasonCode: null,
    reason: null,
    score: null,
    costUsd: null,
    policyId: null,
    policyVersion: null,
    decisionPolicyId: null,
    decisionPolicyVersion: null,
    lifecycle: null,
    sampleRate: null,
    sampled: null,
    sampleSelector: null,
    sampleDisplay: null,
    stages: null,
    verifiers: null,
    tally: null,
    decidedBy: null,
    evaluatedAt: null,
    settlementOutcome: null,
    settledAt: null,
    attempts: 0,
    lastError: null,
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    updatedAt: new Date('2026-08-10T10:00:01.000Z'),
    ...overrides,
  } as VerificationRecordEntity;
}

function buildIntent(overrides: Partial<PaymentIntentEntity> = {}): PaymentIntentEntity {
  return {
    id: 'intent-1',
    organizationId: 'org-buyer-1',
    status: 'SETTLED',
    statusReason: null,
    agentId: 'agent-1',
    agentAccount: 'solana:agent',
    providerId: PROVIDER,
    providerAccount: 'solana:provider',
    toolId: 'tool-1',
    bindingId: 'binding-1',
    rail: 'RAIL_A_PER_CALL',
    callId: 'call-1',
    callClass: 'PAID',
    assetId: 'solana:101/token:usdc',
    decimals: 6,
    priceAmount: '1000000',
    providerAmount: '900000',
    platformFee: '100000',
    settledAmount: '1000000',
    requestHash: 'hash',
    spendPolicyVersion: null,
    chainId: 'solana:101',
    expiresAt: new Date('2026-08-10T10:05:00.000Z'),
    idempotencyKey: null,
    holdId: null,
    holdReleasedAt: null,
    classification: null,
    verificationVerdict: null,
    createdAt: new Date('2026-08-10T09:59:00.000Z'),
    updatedAt: new Date('2026-08-10T10:00:00.000Z'),
    ...overrides,
  } as PaymentIntentEntity;
}

function buildSlaCall(overrides: Partial<SlaWindowCallEntity> = {}): SlaWindowCallEntity {
  return {
    id: 'call-row-1',
    organizationId: 'org-buyer-1',
    windowId: 'window-1',
    intentId: 'intent-1',
    agentId: 'agent-1',
    verdict: null,
    reasonCode: null,
    countedAsQuality: true,
    countedAsFailure: false,
    priceAmount: '1000000',
    assetId: 'solana:101/token:usdc',
    postedAt: new Date('2026-08-10T10:00:05.000Z'),
    createdAt: new Date('2026-08-10T10:00:05.000Z'),
    updatedAt: new Date('2026-08-10T10:00:05.000Z'),
    ...overrides,
  } as SlaWindowCallEntity;
}

function buildPack(overrides: Partial<EvidencePackEntity> = {}): EvidencePackEntity {
  return {
    id: 'pack-1',
    organizationId: 'org-buyer-1',
    verdictId: 'record-1',
    intentId: 'intent-1',
    providerId: PROVIDER,
    seq: '1',
    core: {},
    requestSha256: null,
    responseSha256: null,
    contentHash: 'a'.repeat(64),
    prevHash: null,
    sealedAt: new Date('2026-08-10T10:00:06.000Z'),
    bodyExpiresAt: new Date('2026-08-13T10:00:06.000Z'),
    createdAt: new Date('2026-08-10T10:00:06.000Z'),
    updatedAt: new Date('2026-08-10T10:00:06.000Z'),
    ...overrides,
  } as EvidencePackEntity;
}

function buildBody(overrides: Partial<EvidenceBodyEntity> = {}): EvidenceBodyEntity {
  return {
    id: 'body-1',
    organizationId: 'org-buyer-1',
    packId: 'pack-1',
    request: null,
    response: null,
    expiresAt: new Date('2026-08-13T10:00:06.000Z'),
    createdAt: new Date('2026-08-10T10:00:06.000Z'),
    updatedAt: new Date('2026-08-10T10:00:06.000Z'),
    ...overrides,
  } as EvidenceBodyEntity;
}

/**
 * Wires one fixed query-builder fixture per repository. Each repository is
 * called at most once per `list()`/`getById()` invocation in these tests, so
 * one fixture per repo is enough — see `fake-query-builder.ts`'s own comment
 * for why the fake does not evaluate the SQL it records.
 */
function build(options: {
  records?: VerificationRecordEntity[];
  intents?: PaymentIntentEntity[];
  slaCalls?: SlaWindowCallEntity[];
  packs?: EvidencePackEntity[];
  bodies?: EvidenceBodyEntity[];
}) {
  const recordsFake = fakeQueryBuilder(options.records ?? []);
  const intentsFake = fakeQueryBuilder(options.intents ?? []);
  const slaCallsFake = fakeQueryBuilder(options.slaCalls ?? []);
  const packsFake = fakeQueryBuilder(options.packs ?? []);
  const bodiesFake = fakeQueryBuilder(options.bodies ?? []);

  const records = {
    createQueryBuilder: jest.fn().mockReturnValue(recordsFake.qb),
  } as unknown as VerificationRecordRepository;
  const intents = {
    createQueryBuilder: jest.fn().mockReturnValue(intentsFake.qb),
  } as unknown as PaymentIntentRepository;
  const slaCalls = {
    createQueryBuilder: jest.fn().mockReturnValue(slaCallsFake.qb),
  } as unknown as SlaWindowCallRepository;
  const evidencePacks = {
    createQueryBuilder: jest.fn().mockReturnValue(packsFake.qb),
  } as unknown as EvidencePackRepository;
  const evidenceBodies = {
    createQueryBuilder: jest.fn().mockReturnValue(bodiesFake.qb),
  } as unknown as EvidenceBodyRepository;

  const service = new ProviderVerdictService(
    records,
    intents,
    slaCalls,
    evidencePacks,
    evidenceBodies,
  );

  return {
    service,
    recordsFake,
    intentsFake,
    slaCallsFake,
    packsFake,
    bodiesFake,
    intents,
    slaCalls,
    evidencePacks,
    evidenceBodies,
  };
}

describe('ProviderVerdictService.list — scoping', () => {
  it('reads by provider_id, tautologically satisfying the organization-scope guard', async () => {
    const { service, recordsFake } = build({ records: [] });

    await service.list(PROVIDER, listQuery());

    const sql = recordsFake.wheres.map((w) => w.sql).join(' ');
    expect(sql).toMatch(/organizationId/);
    expect(sql).toMatch(/providerId/);
    expect(recordsFake.wheres.some((w) => w.params.providerId === PROVIDER)).toBe(true);
  });

  it('skips every batched lookup when the page is empty', async () => {
    const { service, intents, slaCalls, evidencePacks, evidenceBodies } = build({ records: [] });

    await service.list(PROVIDER, listQuery());

    expect(intents.createQueryBuilder).not.toHaveBeenCalled();
    expect(slaCalls.createQueryBuilder).not.toHaveBeenCalled();
    expect(evidencePacks.createQueryBuilder).not.toHaveBeenCalled();
    expect(evidenceBodies.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('ProviderVerdictService.list — filters', () => {
  it('does not join payment_intents when agentId is omitted', async () => {
    const { service, recordsFake } = build({ records: [buildRecord()] });

    await service.list(PROVIDER, listQuery());

    expect(recordsFake.joins).toEqual([]);
  });

  it('joins payment_intents and filters on agent_id when agentId is given', async () => {
    const { service, recordsFake } = build({ records: [buildRecord()] });

    await service.list(PROVIDER, listQuery({ agentId: 'agent-9' }));

    expect(recordsFake.joins.some((j) => j.alias === 'intent')).toBe(true);
    expect(
      recordsFake.wheres.some((w) => /agentId/.test(w.sql) && w.params.agentId === 'agent-9'),
    ).toBe(true);
  });

  it('joins sla_window_calls and filters on window_id when windowId is given', async () => {
    const { service, recordsFake } = build({ records: [buildRecord()] });

    await service.list(PROVIDER, listQuery({ windowId: 'window-9' }));

    expect(recordsFake.joins.some((j) => j.alias === 'swc')).toBe(true);
    expect(
      recordsFake.wheres.some((w) => /windowId/.test(w.sql) && w.params.windowId === 'window-9'),
    ).toBe(true);
  });

  it('filters on verdictStatus IN (...) when given', async () => {
    const { service, recordsFake } = build({ records: [] });

    await service.list(PROVIDER, listQuery({ verdictStatus: [VerdictStatus.FAIL] }));

    expect(
      recordsFake.wheres.some(
        (w) => /verdictStatus/.test(w.sql) && Array.isArray(w.params.verdictStatus),
      ),
    ).toBe(true);
  });

  it('filters on reasonCode — the "rule" filter — when given', async () => {
    const { service, recordsFake } = build({ records: [] });

    await service.list(PROVIDER, listQuery({ reasonCode: 'MIN_ARRAY_LENGTH' }));

    expect(
      recordsFake.wheres.some(
        (w) => /reasonCode/.test(w.sql) && w.params.reasonCode === 'MIN_ARRAY_LENGTH',
      ),
    ).toBe(true);
  });
});

describe('ProviderVerdictService.list — DTO mapping', () => {
  it('carries callId / callClass / agentId from the batched payment_intents lookup', async () => {
    const { service } = build({
      records: [buildRecord({ id: 'r1', intentId: 'i1' })],
      intents: [buildIntent({ id: 'i1', callId: 'call-abc', callClass: 'PAID', agentId: 'ag-1' })],
    });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].callId).toBe('call-abc');
    expect(page.items[0].callClass).toBe('PAID');
    expect(page.items[0].agentId).toBe('ag-1');
  });

  it('is null for callId / callClass / agentId when no matching intent was found', async () => {
    const { service } = build({
      records: [buildRecord({ id: 'r1', intentId: 'i1' })],
      intents: [],
    });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].callId).toBeNull();
    expect(page.items[0].callClass).toBeNull();
    expect(page.items[0].agentId).toBeNull();
  });

  it('carries windowId and countedTowardWindow from the batched sla_window_calls lookup', async () => {
    const { service } = build({
      records: [buildRecord({ id: 'r1', intentId: 'i1' })],
      slaCalls: [buildSlaCall({ intentId: 'i1', windowId: 'w-1', countedAsQuality: true })],
    });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].windowId).toBe('w-1');
    expect(page.items[0].countedTowardWindow).toBe(true);
  });

  it('is null for windowId and countedTowardWindow when the call never posted to a window', async () => {
    const { service } = build({
      records: [buildRecord({ id: 'r1', intentId: 'i1' })],
      slaCalls: [],
    });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].windowId).toBeNull();
    expect(page.items[0].countedTowardWindow).toBeNull();
  });

  it('retentionState is RAW when the sealed pack still has its body', async () => {
    const { service } = build({
      records: [buildRecord({ id: 'r1' })],
      packs: [buildPack({ id: 'p1', verdictId: 'r1' })],
      bodies: [buildBody({ packId: 'p1' })],
    });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].retentionState).toBe('RAW');
  });

  it('bodiesExpireAt is the body row’s own expiry, not created_at + 72h (BUG-R2-V3-01)', async () => {
    const expiresAt = new Date('2026-10-14T06:10:00.000Z');
    const { service } = build({
      records: [buildRecord({ id: 'r1' })],
      packs: [buildPack({ id: 'p1', verdictId: 'r1' })],
      bodies: [buildBody({ packId: 'p1', expiresAt })],
    });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].bodiesExpireAt).toEqual(expiresAt);
  });

  it('retentionState is DIGESTED when the pack is sealed but its body has expired', async () => {
    const { service } = build({
      records: [buildRecord({ id: 'r1' })],
      packs: [buildPack({ id: 'p1', verdictId: 'r1' })],
      bodies: [],
    });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].retentionState).toBe('DIGESTED');
  });

  it('retentionState is null when there is no sealed pack at all (pre-evidence-pack)', async () => {
    const { service } = build({
      records: [buildRecord({ id: 'r1' })],
      packs: [],
    });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].retentionState).toBeNull();
  });

  it('bindingVersion is always null — no column captures it', async () => {
    const { service } = build({ records: [buildRecord({ id: 'r1' })] });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].bindingVersion).toBeNull();
  });

  it('failingRules lists deduplicated FAIL verifier codes, and only those', async () => {
    const { service } = build({
      records: [
        buildRecord({
          id: 'r1',
          verifiers: [
            { verifierId: 'v1', outcome: VerifierOutcome.FAIL, code: 'MIN_ARRAY_LENGTH' },
            { verifierId: 'v2', outcome: VerifierOutcome.PASS, code: 'REQUIRED_FIELDS' },
            { verifierId: 'v3', outcome: VerifierOutcome.FAIL, code: 'FRESHNESS' },
            // A second FAIL with the same code as v1 must not duplicate it.
            { verifierId: 'v4', outcome: VerifierOutcome.FAIL, code: 'MIN_ARRAY_LENGTH' },
          ],
        }),
      ],
    });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].failingRules).toEqual(['MIN_ARRAY_LENGTH', 'FRESHNESS']);
  });

  it('failingRules is [], not null, when nothing failed', async () => {
    const { service } = build({
      records: [buildRecord({ id: 'r1', verifiers: [{ verifierId: 'v1', outcome: 'PASS' }] })],
    });

    const page = await service.list(PROVIDER, listQuery());

    expect(page.items[0].failingRules).toEqual([]);
  });
});

describe('ProviderVerdictService.getById', () => {
  it('scopes by provider_id and id, tautologically satisfying the organization-scope guard', async () => {
    const { service, recordsFake } = build({ records: [buildRecord({ id: 'r1' })] });

    await service.getById(PROVIDER, { id: 'r1' } as GetVerdictParamsDto);

    const sql = recordsFake.wheres.map((w) => w.sql).join(' ');
    expect(sql).toMatch(/organizationId/);
    expect(sql).toMatch(/providerId/);
    expect(recordsFake.wheres.some((w) => w.params.id === 'r1')).toBe(true);
  });

  it('404s — never 403s — for a verdict this provider did not serve', async () => {
    const { service } = build({ records: [] });

    await expectErrorCodeAsync(
      () => service.getById(PROVIDER, { id: 'missing' } as GetVerdictParamsDto),
      VerificationErrorCode.VERIFICATION_VERDICT_NOT_FOUND,
    );
  });

  it('fills all four pipeline stages, in order, even when only one ran', async () => {
    const { service } = build({
      records: [
        buildRecord({
          id: 'r1',
          stages: [{ stage: 'SCHEMA', status: 'PASSED', code: null, detail: null, score: null }],
        }),
      ],
      intents: [buildIntent({ id: 'intent-1' })],
    });

    const detail = await service.getById(PROVIDER, { id: 'r1' } as GetVerdictParamsDto);

    expect(detail.stageResults).toHaveLength(4);
    expect(detail.stageResults[0].stage).toBe('SCHEMA');
    expect(detail.stageResults[0].passed).toBe(true);
    expect(detail.stageResults[1].status).toBe('NOT_REACHED');
  });

  it('links to the evidence route rather than duplicating its body', async () => {
    const { service } = build({
      records: [buildRecord({ id: 'r1' })],
      intents: [buildIntent({ id: 'intent-1' })],
    });

    const detail = await service.getById(PROVIDER, { id: 'r1' } as GetVerdictParamsDto);

    expect(detail.evidenceUrl).toBe('/providers/me/verdicts/r1/evidence');
    expect(detail).not.toHaveProperty('request');
    expect(detail).not.toHaveProperty('response');
  });

  describe('production consequence', () => {
    it('reports the settlement instruction actually applied, not a re-derived one', async () => {
      const { service } = build({
        records: [
          buildRecord({
            id: 'r1',
            verdictStatus: VerdictStatus.FAIL,
            settlementOutcome: 'REFUND',
            settledAt: new Date('2026-08-10T10:05:00.000Z'),
          }),
        ],
        intents: [buildIntent({ id: 'intent-1' })],
      });

      const detail = await service.getById(PROVIDER, { id: 'r1' } as GetVerdictParamsDto);

      expect(detail.consequence.settlementOutcome).toBe('REFUND');
      expect(detail.consequence.strike).toBe(true);
    });

    it('strike is false for a SETTLE outcome and null while unsettled', async () => {
      const settled = build({
        records: [buildRecord({ id: 'r1', settlementOutcome: 'SETTLE' })],
        intents: [buildIntent({ id: 'intent-1' })],
      });
      const settledDetail = await settled.service.getById(PROVIDER, {
        id: 'r1',
      } as GetVerdictParamsDto);
      expect(settledDetail.consequence.strike).toBe(false);

      const unsettled = build({
        records: [buildRecord({ id: 'r1', state: 'JUDGED', settlementOutcome: null })],
        intents: [buildIntent({ id: 'intent-1' })],
      });
      const unsettledDetail = await unsettled.service.getById(PROVIDER, {
        id: 'r1',
      } as GetVerdictParamsDto);
      expect(unsettledDetail.consequence.strike).toBeNull();
    });

    it('renders the intent amounts through MoneyUtil, in minor units', async () => {
      const { service } = build({
        records: [buildRecord({ id: 'r1' })],
        intents: [
          buildIntent({
            id: 'intent-1',
            priceAmount: '1000000',
            providerAmount: '900000',
            platformFee: '100000',
            assetId: 'solana:101/token:usdc',
            decimals: 6,
          }),
        ],
      });

      const detail = await service.getById(PROVIDER, { id: 'r1' } as GetVerdictParamsDto);

      expect(detail.consequence.price).toEqual({
        amount: '1000000',
        asset: 'solana:101/token:usdc',
        decimals: 6,
      });
      expect(detail.consequence.providerAmount?.amount).toBe('900000');
      expect(detail.consequence.platformFee?.amount).toBe('100000');
    });

    it('reports absence rather than a fabricated zero when no matching intent exists', async () => {
      const { service } = build({
        records: [buildRecord({ id: 'r1', intentId: 'ghost-intent' })],
        intents: [],
      });

      const detail = await service.getById(PROVIDER, { id: 'r1' } as GetVerdictParamsDto);

      expect(detail.consequence.intentStatus).toBeNull();
      expect(detail.consequence.price).toBeNull();
      expect(detail.consequence.providerAmount).toBeNull();
      expect(detail.consequence.platformFee).toBeNull();
      expect(detail.consequence.settledAmount).toBeNull();
    });
  });
});
