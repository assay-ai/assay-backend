import { OverrideLogEntryEntity } from '@database/postgres/entities/override-log-entry.entity';
import { OperatorBuyerDebtsController } from '@modules/operator/controllers/operator-buyer-debts.controller';
import { OperatorOverrideLogController } from '@modules/operator/controllers/operator-override-log.controller';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { ListOverrideLogQueryDto } from '@modules/operator/dto/operator-console.dto';
import { REQUIRE_ROLES_METADATA } from '@shared/auth/require-roles.decorator';

import { fakeQueryBuilder } from '../provider/helpers/fake-query-builder';

/**
 * Review 2026-10-30: who may read the buyer-debt list, and the activity feed's
 * outcome of a bulk void (the console said "voided 1" when 0 were voided).
 */
describe('GET /operator/buyer-debts roles', () => {
  it('is TRE and ADJL only: not ADJ, not SRE', () => {
    const roles = Reflect.getMetadata(
      REQUIRE_ROLES_METADATA,
      OperatorBuyerDebtsController.prototype.list,
    ) as OperatorRole[];
    expect([...roles].sort()).toEqual([OperatorRole.ADJL, OperatorRole.TRE].sort());
  });
});

describe('GET /operator/override-log — a bulk void carries its outcome', () => {
  const APPROVAL = '11111111-1111-4111-8111-111111111111';

  function entry(patch: Partial<OverrideLogEntryEntity>): OverrideLogEntryEntity {
    return {
      id: patch.id ?? 'e-1',
      createdAt: new Date('2026-10-30T10:00:00Z'),
      family: 'M',
      code: 'M-1',
      action: 'buyer_debt.bulk_voided',
      actorOperatorId: 'op-1',
      approverOperatorId: 'op-2',
      approvalMode: 'TWO_PERSON',
      targetType: 'buyer_debt_void',
      targetId: 'abc',
      organizationId: null,
      reasonCode: 'PLATFORM_FAULT',
      reason: 'r',
      before: {},
      after: { count: 1, approvalId: APPROVAL },
      ticketRef: null,
      breakGlass: false,
      ...patch,
    } as OverrideLogEntryEntity;
  }

  function controller(rows: OverrideLogEntryEntity[], result: Record<string, unknown> | null) {
    const findManyById = jest.fn(async (ids: readonly string[]) =>
      ids.includes(APPROVAL) ? [{ id: APPROVAL, result }] : [],
    );
    const built = new OperatorOverrideLogController(
      { feedQueryBuilder: () => fakeQueryBuilder(rows).qb } as never,
      { findById: async () => null } as never,
      { findManyById } as never,
    );
    return { built, findManyById };
  }

  const query = () => Object.assign(new ListOverrideLogQueryDto(), { limit: 25 });

  it('exposes voidedCount, skippedCount and the amounts from the approval result', async () => {
    const { built, findManyById } = controller(
      [entry({}), entry({ id: 'e-2', code: 'A-9', targetType: 'account_block', after: {} })],
      {
        approvalId: APPROVAL,
        assetId: 'asset',
        decimals: 6,
        requestedCount: 1,
        requestedAmount: '1000000',
        voidedCount: 0,
        voidedAmount: '0',
        skippedCount: 1,
        skippedAmount: '1000000',
        complete: true,
        recordedAt: '2026-10-30T10:00:01.000Z',
        items: [],
      },
    );

    const page = await built.list(query());

    expect(page.items[0].outcome).toEqual({
      approvalId: APPROVAL,
      assetId: 'asset',
      decimals: 6,
      requestedCount: 1,
      requestedAmount: '1000000',
      voidedCount: 0,
      voidedAmount: '0',
      skippedCount: 1,
      skippedAmount: '1000000',
      complete: true,
    });
    // Other entries carry no outcome field at all.
    expect('outcome' in page.items[1]).toBe(false);
    expect(findManyById).toHaveBeenCalledTimes(1);
    expect(findManyById).toHaveBeenCalledWith([APPROVAL]);
  });

  it('is null while the void runs, and on an entry that names no approval', async () => {
    const running = controller([entry({})], null);
    expect((await running.built.list(query())).items[0].outcome).toBeNull();

    const older = controller([entry({ after: { count: 2 } })], null);
    expect((await older.built.list(query())).items[0].outcome).toBeNull();
    expect(older.findManyById).toHaveBeenCalledWith([]);
  });
});
