/**
 * `V-7` — the first and only writer of `providers.verified`.
 *
 * Three properties are worth a test here, and the third is the one that would
 * hurt in production:
 *
 * 1. A verify writes all seven columns *and* leaves a register entry — the
 *    write goes through `OverrideLogService.perform`, so a row that changed
 *    without an entry is not a shape this service can produce.
 * 2. Clearing the label clears its attributor. A `verified: false` row that
 *    keeps `verifiedBy` reads, to every caller, as "somebody checked this and
 *    it failed" rather than "nobody has checked".
 * 3. `chk_providers_verified_attributed` is a real database CHECK, and an
 *    in-memory fake that does not have it would let the service ask Postgres
 *    for a row Postgres refuses — green here, 500 there. So `FakeTxManager`
 *    enforces the constraint itself and the tests below are written against a
 *    fake that can say no.
 */
import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';

import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OperatorProviderVerificationService } from '@modules/operator/services/operator-provider-verification.service';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const PROVIDER = 'org-11111111-1111-4111-8111-111111111111';
const PROVIDER_ROW_ID = 'prv-11111111-1111-4111-8111-111111111111';
const MISSING_PROVIDER = 'org-99999999-9999-4999-8999-999999999999';

const NOTE =
  'Reviewed the operator of record against the registry filing, called the published support ' +
  'line, and confirmed the payout account belongs to the same legal entity as the domain.';

const OPERATOR: OperatorSession = {
  operatorId: 'op_1',
  subject: 'dan@',
  displayName: 'Dan',
  email: 'dan@example.test',
  roles: [OperatorRole.ADJL],
  authorityLimitMinor: null,
};

class FakeProviderRepository {
  readonly rows = new Map<string, Partial<ProviderEntity>>();

  seed(row: Partial<ProviderEntity> & { organizationId: string }): void {
    this.rows.set(row.organizationId, row);
  }

  /**
   * Returns a *detached copy*, which is what TypeORM does — a hydrated entity
   * is a snapshot, not a live handle on the table row. Handing back the stored
   * object instead would make `before` in the override entry read the values
   * the `UPDATE` had already written, and the test would be asserting an
   * aliasing artefact of the fake rather than anything the service does.
   */
  async findOneBy(where: { organizationId: string }): Promise<ProviderEntity | null> {
    const row = this.rows.get(where.organizationId);
    return row ? ({ ...row } as ProviderEntity) : null;
  }

  asRepository(): ProviderRepository {
    return this as unknown as ProviderRepository;
  }
}

/**
 * A query runner over the same rows the repository fake holds, so a test reads
 * the outcome rather than asserting a method was called.
 *
 * Not a copy of `arbitration.service.spec.ts`'s: that one finds its row by
 * `params.proposalId` and gates on a status allowlist. This service filters on
 * `organization_id` and `id` and has no status gate at all, so a fake matching
 * the other predicates would match nothing and every assertion below would be
 * vacuous.
 */
class FakeTxManager {
  constructor(private readonly providers: FakeProviderRepository) {}

  createQueryBuilder() {
    let patch: Record<string, unknown> = {};
    let organizationId = '';
    let id = '';
    const capture = (params?: Record<string, unknown>) => {
      if (typeof params?.organizationId === 'string') organizationId = params.organizationId;
      if (typeof params?.id === 'string') id = params.id;
    };
    const builder = {
      update: () => builder,
      set: (values: Record<string, unknown>) => {
        patch = values;
        return builder;
      },
      where: (_clause: string, params?: Record<string, unknown>) => {
        capture(params);
        return builder;
      },
      andWhere: (_clause: string, params?: Record<string, unknown>) => {
        capture(params);
        return builder;
      },
      execute: async () => {
        const row = this.providers.rows.get(organizationId);
        if (!row || row.id !== id) return { affected: 0 };
        const next = { ...row, ...patch } as Partial<ProviderEntity>;
        assertVerifiedAttributed(next);
        Object.assign(row, patch);
        return { affected: 1 };
      },
    };
    return builder;
  }

  async findOneOrFail(
    _entity: unknown,
    options: { where: { organizationId: string; id: string } },
  ): Promise<ProviderEntity> {
    const row = this.providers.rows.get(options.where.organizationId);
    if (!row || row.id !== options.where.id) {
      throw new Error('EntityNotFoundError');
    }
    return { ...row } as ProviderEntity;
  }
}

/** `chk_providers_verified_attributed`, as the database states it. */
function assertVerifiedAttributed(row: Partial<ProviderEntity>): void {
  if (row.verified === true && (row.verifiedBy == null || row.verifiedAt == null)) {
    throw new Error(
      'new row for relation "providers" violates check constraint ' +
        '"chk_providers_verified_attributed"',
    );
  }
}

interface RecordedOverride {
  readonly code: string;
  readonly targetId: string;
  readonly organizationId: string | null;
  readonly reasonCode: string;
  readonly reason: string;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
}

class PassThroughOverrideLog {
  readonly performed: RecordedOverride[] = [];

  constructor(private readonly manager: FakeTxManager) {}

  async perform<T>(
    context: {
      code: string;
      targetId: string;
      organizationId: string | null;
      reasonCode: string;
      reason: string;
    },
    mutation: (qr: {
      manager: FakeTxManager;
    }) => Promise<{ value: T; before: Record<string, unknown>; after: Record<string, unknown> }>,
  ): Promise<T> {
    const result = await mutation({ manager: this.manager });
    this.performed.push({
      code: context.code,
      targetId: context.targetId,
      organizationId: context.organizationId,
      reasonCode: context.reasonCode,
      reason: context.reason,
      before: result.before,
      after: result.after,
    });
    return result.value;
  }
}

function buildHarness() {
  const providers = new FakeProviderRepository();
  const manager = new FakeTxManager(providers);
  const overrides = new PassThroughOverrideLog(manager);
  const service = new OperatorProviderVerificationService(
    overrides as unknown as ConstructorParameters<typeof OperatorProviderVerificationService>[0],
    providers.asRepository(),
  );
  return { providers, overrides, service };
}

function seedUnverified(providers: FakeProviderRepository): void {
  providers.seed({
    id: PROVIDER_ROW_ID,
    organizationId: PROVIDER,
    legalName: 'Weather Data GmbH',
    verified: false,
    verifiedBy: null,
    verifiedAt: null,
    verificationMethod: null,
    verificationChecks: [],
    verificationExpiresAt: null,
    verificationEvidenceUrl: null,
  });
}

const VERIFY_BODY = {
  verified: true,
  method: 'MANUAL_REVIEW',
  checks: [
    { check: 'LEGAL_ENTITY', result: 'PASS' as const, note: 'Registry filing matches.' },
    { check: 'PAYOUT_OWNERSHIP', result: 'PASS' as const },
  ],
  expiresAt: '2027-01-01T00:00:00.000Z',
  evidenceUrl: 'https://ops.example.test/reviews/1',
  reasonCode: 'MANUAL_REVIEW_COMPLETE',
  note: NOTE,
  ticketRef: 'OPS-1234',
};

describe('setting a provider’s verified label', () => {
  it('writes the label, its author and what was checked, and records V-7', async () => {
    const { providers, overrides, service } = buildHarness();
    seedUnverified(providers);

    const response = await service.setVerification(OPERATOR, PROVIDER, VERIFY_BODY, 'req-1');

    const row = providers.rows.get(PROVIDER)!;
    expect(row.verified).toBe(true);
    expect(row.verifiedBy).toBe(OPERATOR.subject);
    expect(row.verifiedAt).toBeInstanceOf(Date);
    expect(row.verificationMethod).toBe('MANUAL_REVIEW');
    expect(row.verificationChecks).toEqual([
      { check: 'LEGAL_ENTITY', result: 'PASS', note: 'Registry filing matches.' },
      { check: 'PAYOUT_OWNERSHIP', result: 'PASS', note: null },
    ]);
    expect(row.verificationExpiresAt).toEqual(new Date('2027-01-01T00:00:00.000Z'));
    expect(row.verificationEvidenceUrl).toBe('https://ops.example.test/reviews/1');

    expect(response.providerId).toBe(PROVIDER);
    expect(response.verification.verified).toBe(true);
    expect(response.verification.verifiedBy).toBe(OPERATOR.subject);
    expect(response.verification.checks).toHaveLength(2);

    expect(overrides.performed).toHaveLength(1);
    const entry = overrides.performed[0];
    expect(entry.code).toBe('V-7');
    expect(entry.targetId).toBe(PROVIDER_ROW_ID);
    expect(entry.organizationId).toBe(PROVIDER);
    expect(entry.reasonCode).toBe('MANUAL_REVIEW_COMPLETE');
    expect(entry.reason).toBe(NOTE);
    expect(entry.before).toEqual({
      verified: false,
      verifiedBy: null,
      verificationMethod: null,
      verificationChecks: [],
    });
    expect(entry.after).toEqual({
      verified: true,
      verifiedBy: OPERATOR.subject,
      verificationMethod: 'MANUAL_REVIEW',
      verificationChecks: [
        { check: 'LEGAL_ENTITY', result: 'PASS', note: 'Registry filing matches.' },
        { check: 'PAYOUT_OWNERSHIP', result: 'PASS', note: null },
      ],
    });
  });

  it('refuses a provider that does not exist, before touching the register', async () => {
    const { overrides, service } = buildHarness();

    await expectErrorCodeAsync(
      () => service.setVerification(OPERATOR, MISSING_PROVIDER, VERIFY_BODY, null),
      ProviderErrorCode.PROVIDER_NOT_FOUND,
    );

    expect(overrides.performed).toEqual([]);
  });

  it('clears the attributor when the label is taken away', async () => {
    const { providers, overrides, service } = buildHarness();
    seedUnverified(providers);

    await service.setVerification(OPERATOR, PROVIDER, VERIFY_BODY, null);
    await service.setVerification(
      OPERATOR,
      PROVIDER,
      {
        verified: false,
        method: 'MANUAL_REVIEW',
        checks: [{ check: 'LEGAL_ENTITY', result: 'FAIL' as const, note: 'Filing withdrawn.' }],
        reasonCode: 'LABEL_WITHDRAWN',
        note: NOTE,
      },
      null,
    );

    const row = providers.rows.get(PROVIDER)!;
    expect(row.verified).toBe(false);
    expect(row.verifiedBy).toBeNull();
    expect(row.verifiedAt).toBeNull();
    expect(row.verificationMethod).toBeNull();
    // The checks do NOT survive the clear: they are replaced wholesale by the
    // checks the clearing request supplied. So the row keeps a record of why
    // the label was withdrawn, and keeps none of what earned it — which is
    // exactly why the override entry below has to carry the old findings.
    expect(row.verificationChecks).toEqual([
      { check: 'LEGAL_ENTITY', result: 'FAIL', note: 'Filing withdrawn.' },
    ]);

    expect(overrides.performed).toHaveLength(2);
    // `reversible: true` on `V-7` is only true if this row is enough to
    // reconstruct the verification that was withdrawn. The row is the only
    // place the original findings still exist after the write above.
    expect(overrides.performed[1].before).toEqual({
      verified: true,
      verifiedBy: OPERATOR.subject,
      verificationMethod: 'MANUAL_REVIEW',
      verificationChecks: [
        { check: 'LEGAL_ENTITY', result: 'PASS', note: 'Registry filing matches.' },
        { check: 'PAYOUT_OWNERSHIP', result: 'PASS', note: null },
      ],
    });
    expect(overrides.performed[1].after).toEqual({
      verified: false,
      verifiedBy: null,
      verificationMethod: null,
      verificationChecks: [{ check: 'LEGAL_ENTITY', result: 'FAIL', note: 'Filing withdrawn.' }],
    });
  });

  it('never asks the database for a verified row with no attributor', async () => {
    const { providers, service } = buildHarness();
    seedUnverified(providers);

    // `FakeTxManager` refuses exactly what `chk_providers_verified_attributed`
    // refuses, so a service that set `verified` in one statement and its author
    // in another — or that left a stale author behind — throws here.
    await service.setVerification(OPERATOR, PROVIDER, VERIFY_BODY, null);
    await service.setVerification(OPERATOR, PROVIDER, { ...VERIFY_BODY, verified: false }, null);
    await service.setVerification(OPERATOR, PROVIDER, VERIFY_BODY, null);

    const row = providers.rows.get(PROVIDER)!;
    expect(row.verified).toBe(true);
    expect(row.verifiedBy).toBe(OPERATOR.subject);
    expect(row.verifiedAt).toBeInstanceOf(Date);
  });
});
