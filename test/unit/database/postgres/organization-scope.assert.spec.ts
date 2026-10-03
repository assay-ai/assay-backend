import { In, IsNull, Not } from 'typeorm';
import {
  assertOrganizationScopedCriteria,
  assertOrganizationScopedFindOptions,
  assertOrganizationScopedSql,
  assertOrganizationScopedValues,
  assertOrganizationScopedWhere,
} from '@database/postgres/organization-scope';
import { OrganizationErrorCode } from '@shared/errors/organization-scope.errors';
import { AppError } from '@shared/errors/app-errors';

const ORG = '3f1c8d2a-0000-4000-8000-000000000001';
const OTHER_ORG = '3f1c8d2a-0000-4000-8000-000000000002';

function codeOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).errorCode;
  }
  throw new Error('expected the guard to throw, but it did not');
}

describe('organization scope guard', () => {
  describe('assertOrganizationScopedWhere', () => {
    it('throws when the where clause omits organizationId', () => {
      expect(codeOf(() => assertOrganizationScopedWhere({ status: 'CREATED' }, 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
    });

    it('throws when the where clause is undefined', () => {
      expect(codeOf(() => assertOrganizationScopedWhere(undefined, 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
    });

    it('throws when organizationId is present but null', () => {
      expect(codeOf(() => assertOrganizationScopedWhere({ organizationId: null }, 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
    });

    it('passes when organizationId is constrained', () => {
      expect(() =>
        assertOrganizationScopedWhere({ organizationId: ORG, status: 'CREATED' }, 'op'),
      ).not.toThrow();
    });

    it('passes for In(), which enumerates the organizations it touches', () => {
      expect(() =>
        assertOrganizationScopedWhere({ organizationId: In([ORG, OTHER_ORG]) }, 'op'),
      ).not.toThrow();
    });

    it('rejects Not(orgId) — it reads every OTHER tenant, the exact leak', () => {
      expect(codeOf(() => assertOrganizationScopedWhere({ organizationId: Not(ORG) }, 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_NEGATED,
      );
    });

    it('rejects IsNull()', () => {
      expect(codeOf(() => assertOrganizationScopedWhere({ organizationId: IsNull() }, 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_NEGATED,
      );
    });

    it('requires EVERY branch of an OR array to be scoped', () => {
      expect(
        codeOf(() =>
          assertOrganizationScopedWhere(
            [{ organizationId: ORG, status: 'CREATED' }, { status: 'SETTLED' }],
            'op',
          ),
        ),
      ).toBe(OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING);
    });

    it('passes when every branch is scoped', () => {
      expect(() =>
        assertOrganizationScopedWhere(
          [
            { organizationId: ORG, status: 'CREATED' },
            { organizationId: ORG, status: 'SETTLED' },
          ],
          'op',
        ),
      ).not.toThrow();
    });

    it('rejects an empty OR array', () => {
      expect(codeOf(() => assertOrganizationScopedWhere([], 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
    });
  });

  describe('assertOrganizationScopedFindOptions', () => {
    it('throws when find() is called with no options at all', () => {
      expect(codeOf(() => assertOrganizationScopedFindOptions(undefined, 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
    });

    it('throws when options carry no where', () => {
      expect(codeOf(() => assertOrganizationScopedFindOptions({ take: 10 }, 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
    });

    it('passes with a scoped where', () => {
      expect(() =>
        assertOrganizationScopedFindOptions({ where: { organizationId: ORG }, take: 10 }, 'op'),
      ).not.toThrow();
    });
  });

  describe('assertOrganizationScopedCriteria', () => {
    it.each([
      ['a bare uuid', ORG],
      ['a number', 42],
    ])('rejects %s as update/delete criteria', (_label, criteria) => {
      expect(codeOf(() => assertOrganizationScopedCriteria(criteria, 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
    });

    it('rejects an array of bare ids', () => {
      expect(codeOf(() => assertOrganizationScopedCriteria([ORG, OTHER_ORG], 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING,
      );
    });

    it('passes for { organizationId, id }', () => {
      expect(() =>
        assertOrganizationScopedCriteria({ organizationId: ORG, id: 'row-1' }, 'op'),
      ).not.toThrow();
    });
  });

  describe('assertOrganizationScopedValues', () => {
    it('throws when a written row has no organizationId', () => {
      expect(codeOf(() => assertOrganizationScopedValues({ title: 'x' }, 'op'))).toBe(
        OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING_ON_WRITE,
      );
    });

    it('throws when ANY row in a batch is unscoped', () => {
      expect(
        codeOf(() =>
          assertOrganizationScopedValues([{ organizationId: ORG }, { title: 'x' }], 'op'),
        ),
      ).toBe(OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING_ON_WRITE);
    });

    it('passes when every row carries organizationId', () => {
      expect(() =>
        assertOrganizationScopedValues([{ organizationId: ORG }, { organizationId: ORG }], 'op'),
      ).not.toThrow();
    });
  });

  describe('assertOrganizationScopedSql', () => {
    it('throws when the built SQL never references organization_id', () => {
      expect(() =>
        assertOrganizationScopedSql('SELECT * FROM payment_intents WHERE status = $1', 'op'),
      ).toThrow(/ORGANIZATION|organizationId/);
    });

    it('passes when the built SQL constrains organization_id', () => {
      expect(() =>
        assertOrganizationScopedSql(
          'SELECT * FROM payment_intents WHERE organization_id = $1 AND status = $2',
          'op',
        ),
      ).not.toThrow();
    });

    it('does not match a column that merely contains the name as a substring', () => {
      expect(
        codeOf(() =>
          assertOrganizationScopedSql(
            'SELECT * FROM t WHERE prev_organization_identifier = $1',
            'op',
          ),
        ),
      ).toBe(OrganizationErrorCode.ORGANIZATION_SCOPE_MISSING);
    });
  });
});
