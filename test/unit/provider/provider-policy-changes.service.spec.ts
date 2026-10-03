import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { ProviderPolicyChangesService } from '@modules/provider/services/provider-policy-changes.service';

/**
 * Hand-written fakes, in the style `test/unit/provider/helpers/` and the
 * house docstring require: no `jest.mock` of a repository, rows held in
 * memory so the test can assert what the service actually reads and returns.
 * Neither `ToolBindingRepository` nor `VerificationPolicyRepository` has an
 * existing fake in `test/unit/provider/helpers/`, `test/unit/verification/
 * helpers/` or `test/unit/payment/helpers/`, so these are local to this spec
 * rather than a new shared helpers file.
 */

function bindingRow(overrides: Partial<ToolBindingEntity> = {}): ToolBindingEntity {
  return {
    id: 'binding-1',
    organizationId: 'provider-1',
    toolId: 'search_web',
    endpoint: 'https://example.com/search',
    requestMapping: {},
    responseMapping: {},
    pricingMode: 'PAID',
    priceAmount: '1000',
    assetId: 'solana:mainnet/usdc',
    freeQuotaPerAgent: null,
    freeDailyBudget: null,
    slaFailureRate: '0.05',
    timeoutMs: 5000,
    status: 'ACTIVE',
    mappingVersion: 1,
    publishedVersion: 1,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    maxRps: null,
    maxDailyCalls: null,
    pauseReason: null,
    pausedAt: null,
    ...overrides,
  } as unknown as ToolBindingEntity;
}

function policyRow(overrides: Partial<VerificationPolicyEntity> = {}): VerificationPolicyEntity {
  return {
    id: 'policy-row-1',
    policyId: 'search_web.default',
    policyVersion: 1,
    toolId: 'search_web',
    lifecycle: 'ACTIVE',
    decisionDocument: { passThreshold: 0.7 },
    verificationDocument: null,
    createdBy: 'operator@platform',
    promotedAt: new Date('2026-01-01T00:00:00Z'),
    promotedBy: 'operator@platform',
    promotionEvidence: { falsePositiveRate: 0.01 },
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawnReason: null,
    ...overrides,
  } as unknown as VerificationPolicyEntity;
}

class FakeToolBindingRepository {
  rows: ToolBindingEntity[] = [];
  lastWhere: Record<string, unknown> | undefined;

  seed(row: ToolBindingEntity): ToolBindingEntity {
    this.rows.push(row);
    return row;
  }

  async find(options: { where: { organizationId: string } }): Promise<ToolBindingEntity[]> {
    this.lastWhere = options.where;
    return this.rows.filter((row) => row.organizationId === options.where.organizationId);
  }
}

class FakeVerificationPolicyRepository {
  rows: VerificationPolicyEntity[] = [];
  calls: Array<{ toolId: string; lifecycle: string }> = [];

  seed(row: VerificationPolicyEntity): VerificationPolicyEntity {
    this.rows.push(row);
    return row;
  }

  async findOne(options: {
    where: { toolId: string; lifecycle: string };
  }): Promise<VerificationPolicyEntity | null> {
    this.calls.push(options.where);
    return (
      this.rows.find(
        (row) => row.toolId === options.where.toolId && row.lifecycle === options.where.lifecycle,
      ) ?? null
    );
  }
}

describe('ProviderPolicyChangesService', () => {
  let bindings: FakeToolBindingRepository;
  let policies: FakeVerificationPolicyRepository;
  let service: ProviderPolicyChangesService;

  beforeEach(() => {
    bindings = new FakeToolBindingRepository();
    policies = new FakeVerificationPolicyRepository();
    service = new ProviderPolicyChangesService(
      bindings as unknown as ToolBindingRepository,
      policies as unknown as VerificationPolicyRepository,
    );
  });

  it('returns nothing for a provider with no bindings', async () => {
    const result = await service.listPolicyChanges('provider-1');

    expect(result).toEqual([]);
  });

  it('scopes the binding read to the caller’s own organizationId', async () => {
    bindings.seed(bindingRow({ organizationId: 'provider-1' }));
    bindings.seed(bindingRow({ id: 'binding-2', organizationId: 'provider-2' }));
    policies.seed(policyRow({ lifecycle: 'SHADOW', policyVersion: 2 }));

    await service.listPolicyChanges('provider-1');

    expect(bindings.lastWhere).toEqual({ organizationId: 'provider-1' });
  });

  it('returns nothing for a tool with no pending (SHADOW) version, even with an ACTIVE one', async () => {
    bindings.seed(bindingRow());
    policies.seed(policyRow({ lifecycle: 'ACTIVE' }));

    const result = await service.listPolicyChanges('provider-1');

    expect(result).toEqual([]);
  });

  it('ignores a DRAFT version — never resolved for traffic, so never "pending"', async () => {
    bindings.seed(bindingRow());
    policies.seed(policyRow({ lifecycle: 'DRAFT', policyVersion: 2 }));

    const result = await service.listPolicyChanges('provider-1');

    expect(result).toEqual([]);
  });

  it('reports a pending SHADOW version against the ACTIVE one, with a structural diff', async () => {
    bindings.seed(bindingRow({ id: 'binding-1', status: 'ACTIVE' }));
    policies.seed(
      policyRow({
        lifecycle: 'ACTIVE',
        policyId: 'search_web.default',
        policyVersion: 3,
        decisionDocument: { passThreshold: 0.7 },
      }),
    );
    policies.seed(
      policyRow({
        lifecycle: 'SHADOW',
        policyId: 'search_web.default',
        policyVersion: 4,
        decisionDocument: { passThreshold: 0.9 },
      }),
    );

    const result = await service.listPolicyChanges('provider-1');

    expect(result).toEqual([
      {
        toolId: 'search_web',
        policyId: 'search_web.default',
        pendingVersion: 4,
        pendingLifecycle: 'SHADOW',
        inForcePolicyId: 'search_web.default',
        inForceVersion: 3,
        effectiveDate: null,
        bindings: [{ bindingId: 'binding-1', status: 'ACTIVE' }],
        diff: [{ path: '$.passThreshold', changeType: 'changed', before: 0.7, after: 0.9 }],
      },
    ]);
  });

  it('reports inForceVersion/inForcePolicyId as null and diffs against nothing when the tool has never been promoted', async () => {
    bindings.seed(bindingRow());
    policies.seed(
      policyRow({
        lifecycle: 'SHADOW',
        policyId: 'search_web.default',
        policyVersion: 1,
        decisionDocument: { passThreshold: 0.7 },
      }),
    );

    const result = await service.listPolicyChanges('provider-1');

    expect(result).toHaveLength(1);
    expect(result[0].inForceVersion).toBeNull();
    expect(result[0].inForcePolicyId).toBeNull();
    expect(result[0].diff).toEqual([
      { path: '$.passThreshold', changeType: 'added', before: undefined, after: 0.7 },
    ]);
  });

  it('always reports effectiveDate as null — no column stores one', async () => {
    bindings.seed(bindingRow());
    policies.seed(policyRow({ lifecycle: 'SHADOW', policyVersion: 2 }));

    const result = await service.listPolicyChanges('provider-1');

    expect(result[0].effectiveDate).toBeNull();
  });

  it('collects every one of this provider’s own bindings on the affected tool', async () => {
    bindings.seed(bindingRow({ id: 'binding-1', status: 'ACTIVE' }));
    bindings.seed(bindingRow({ id: 'binding-2', status: 'PAUSED' }));
    policies.seed(policyRow({ lifecycle: 'SHADOW', policyVersion: 2 }));

    const result = await service.listPolicyChanges('provider-1');

    expect(result[0].bindings).toEqual(
      expect.arrayContaining([
        { bindingId: 'binding-1', status: 'ACTIVE' },
        { bindingId: 'binding-2', status: 'PAUSED' },
      ]),
    );
    expect(result[0].bindings).toHaveLength(2);
  });

  it('includes a binding regardless of status — a PAUSED binding still needs the notice', async () => {
    bindings.seed(bindingRow({ id: 'binding-1', status: 'PAUSED' }));
    policies.seed(policyRow({ lifecycle: 'SHADOW', policyVersion: 2 }));

    const result = await service.listPolicyChanges('provider-1');

    expect(result).toHaveLength(1);
    expect(result[0].bindings).toEqual([{ bindingId: 'binding-1', status: 'PAUSED' }]);
  });

  it('sorts multiple affected tools by toolId', async () => {
    bindings.seed(bindingRow({ id: 'binding-z', toolId: 'zeta_tool' }));
    bindings.seed(bindingRow({ id: 'binding-a', toolId: 'alpha_tool' }));
    policies.seed(policyRow({ toolId: 'zeta_tool', lifecycle: 'SHADOW', policyVersion: 2 }));
    policies.seed(policyRow({ toolId: 'alpha_tool', lifecycle: 'SHADOW', policyVersion: 2 }));

    const result = await service.listPolicyChanges('provider-1');

    expect(result.map((row) => row.toolId)).toEqual(['alpha_tool', 'zeta_tool']);
  });

  it('does not surface a tool this provider has no binding on', async () => {
    bindings.seed(bindingRow({ toolId: 'search_web' }));
    policies.seed(policyRow({ toolId: 'search_web', lifecycle: 'SHADOW', policyVersion: 2 }));
    // A different tool's pending version — no binding of this provider's touches it.
    policies.seed(policyRow({ toolId: 'ais_lookup', lifecycle: 'SHADOW', policyVersion: 2 }));

    const result = await service.listPolicyChanges('provider-1');

    expect(result.map((row) => row.toolId)).toEqual(['search_web']);
  });
});
