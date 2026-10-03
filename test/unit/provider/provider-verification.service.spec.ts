/**
 * `ProviderVerificationService` — the `verified` label.
 *
 * The interesting property under test is the one the class comment names: a
 * read keyed by `providerId`, not by the caller's own `organizationId` — the
 * catalogue asks about a provider that is never the caller. `FakeProviderRepository`
 * still goes through the same `{ organizationId }` shape `ProviderRepository`
 * requires, so this also proves the read is expressed as a scoped query (naming
 * the column), just not scoped *to the caller*.
 */
import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { In } from 'typeorm';

import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderVerificationService } from '@modules/provider/services/provider-verification.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const VERIFIED_PROVIDER = 'org-11111111-1111-4111-8111-111111111111';
const UNVERIFIED_PROVIDER = 'org-22222222-2222-4222-8222-222222222222';
const MISSING_PROVIDER = 'org-99999999-9999-4999-8999-999999999999';

class FakeProviderRepository {
  readonly rows = new Map<string, Partial<ProviderEntity>>();

  seed(row: Partial<ProviderEntity> & { organizationId: string }): void {
    this.rows.set(row.organizationId, row);
  }

  async findOneBy(where: { organizationId: string }): Promise<ProviderEntity | null> {
    const row = this.rows.get(where.organizationId);
    return row ? (row as ProviderEntity) : null;
  }

  async findBy(where: { organizationId: ReturnType<typeof In> }): Promise<ProviderEntity[]> {
    // `In(...)` carries its candidate list on `.value` — mirror what TypeORM's
    // `FindOperator` exposes, since this fake never touches Postgres.
    const ids: string[] = (where.organizationId as unknown as { value: string[] }).value;
    return ids
      .map((id) => this.rows.get(id))
      .filter((row): row is Partial<ProviderEntity> => row !== undefined) as ProviderEntity[];
  }

  asRepository(): ProviderRepository {
    return this as unknown as ProviderRepository;
  }
}

function buildHarness() {
  const providers = new FakeProviderRepository();
  const service = new ProviderVerificationService(providers.asRepository());
  return { providers, service };
}

describe('a verified provider', () => {
  it('serves the label with its author and what was checked', async () => {
    const { providers, service } = buildHarness();
    providers.seed({
      organizationId: VERIFIED_PROVIDER,
      legalName: 'Example Vessel Data Ltd',
      verified: true,
      verifiedBy: 'ops@platform.example',
      verifiedAt: new Date('2026-01-15T00:00:00.000Z'),
      verificationMethod: 'DOCUMENT_REVIEW',
      verificationChecks: [
        { check: 'LEGAL_ENTITY', result: 'PASS', note: 'Companies House filing matched' },
        { check: 'DOMAIN_CONTROL', result: 'PASS', note: null },
      ],
      verificationExpiresAt: null,
      verificationEvidenceUrl: 'https://evidence.platform.example/vesseldata',
    });

    const result = await service.getVerification(VERIFIED_PROVIDER);

    expect(result.providerId).toBe(VERIFIED_PROVIDER);
    expect(result.legalName).toBe('Example Vessel Data Ltd');
    expect(result.verification.verified).toBe(true);
    expect(result.verification.verifiedBy).toBe('ops@platform.example');
    expect(result.verification.verifiedAt).toBe('2026-01-15T00:00:00.000Z');
    expect(result.verification.method).toBe('DOCUMENT_REVIEW');
    expect(result.verification.checks).toEqual([
      { check: 'LEGAL_ENTITY', result: 'PASS', note: 'Companies House filing matched' },
      { check: 'DOMAIN_CONTROL', result: 'PASS', note: null },
    ]);
  });
});

describe('an unverified provider', () => {
  it('serves verified: false with a null author, method and empty checks', async () => {
    const { providers, service } = buildHarness();
    providers.seed({
      organizationId: UNVERIFIED_PROVIDER,
      legalName: 'New Provider LLC',
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
      verificationMethod: null,
      verificationChecks: [],
      verificationExpiresAt: null,
      verificationEvidenceUrl: null,
    });

    const result = await service.getVerification(UNVERIFIED_PROVIDER);

    expect(result.verification).toEqual({
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
      method: null,
      checks: [],
      expiresAt: null,
      evidenceUrl: null,
    });
  });
});

describe('a provider that does not exist', () => {
  it('404s rather than serving an unverified profile for a phantom id', async () => {
    const { service } = buildHarness();

    await expectErrorCodeAsync(
      () => service.getVerification(MISSING_PROVIDER),
      ProviderErrorCode.PROVIDER_NOT_FOUND,
    );
  });
});

describe('the batch read', () => {
  it('answers every requested id in one call, keyed by providerId', async () => {
    const { providers, service } = buildHarness();
    providers.seed({
      organizationId: VERIFIED_PROVIDER,
      legalName: 'Example Vessel Data Ltd',
      verified: true,
      verifiedBy: 'ops@platform.example',
      verifiedAt: new Date('2026-01-15T00:00:00.000Z'),
      verificationMethod: 'DOCUMENT_REVIEW',
      verificationChecks: [],
      verificationExpiresAt: null,
      verificationEvidenceUrl: null,
    });
    providers.seed({
      organizationId: UNVERIFIED_PROVIDER,
      legalName: 'New Provider LLC',
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
      verificationMethod: null,
      verificationChecks: [],
      verificationExpiresAt: null,
      verificationEvidenceUrl: null,
    });

    const results = await service.getVerifications([
      VERIFIED_PROVIDER,
      UNVERIFIED_PROVIDER,
      MISSING_PROVIDER,
    ]);

    expect(results.size).toBe(2);
    expect(results.get(VERIFIED_PROVIDER)?.verification.verified).toBe(true);
    expect(results.get(UNVERIFIED_PROVIDER)?.verification.verified).toBe(false);
    // A stale/unknown id is dropped, not thrown — a listing page over many
    // providers must not fail whole because one id no longer resolves.
    expect(results.has(MISSING_PROVIDER)).toBe(false);
  });

  it('returns an empty map for an empty id list, without querying', async () => {
    const { providers, service } = buildHarness();
    const findBy = jest.spyOn(providers, 'findBy');

    const results = await service.getVerifications([]);

    expect(results.size).toBe(0);
    expect(findBy).not.toHaveBeenCalled();
  });
});
