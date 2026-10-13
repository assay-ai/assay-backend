import { OverrideLogEntryEntity } from '@database/postgres/entities/override-log-entry.entity';
import {
  ApprovalMode,
  OperatorRole,
  OVERRIDE_REGISTER,
} from '@modules/operator/domain/override-register';
import { OperatorErrorCode } from '@modules/operator/errors/operator.errors';
import { OverrideLogService } from '@modules/operator/services/override-log.service';

/**
 * A query runner that records what happened to it, so a test can assert the
 * commit/rollback rather than infer it.
 */
class FakeQueryRunner {
  connected = false;
  started = false;
  committed = false;
  rolledBack = false;
  released = false;

  async connect() {
    this.connected = true;
  }
  async startTransaction() {
    this.started = true;
  }
  async commitTransaction() {
    this.committed = true;
  }
  async rollbackTransaction() {
    this.rolledBack = true;
  }
  async release() {
    this.released = true;
  }
}

class FakeDataSource {
  readonly runner = new FakeQueryRunner();
  createQueryRunner() {
    return this.runner;
  }
}

class FakeEntries {
  readonly appended: Partial<OverrideLogEntryEntity>[] = [];
  throwOnAppend = false;

  async append(_runner: unknown, entry: Partial<OverrideLogEntryEntity>) {
    if (this.throwOnAppend) throw new Error('append failed');
    this.appended.push(entry);
    return entry as OverrideLogEntryEntity;
  }

  async findByTarget() {
    return [];
  }
}

const ADJUDICATOR = {
  operatorId: 'op_1',
  subject: 'dan@',
  displayName: 'Dan',
  email: 'dan@example.test',
  roles: [OperatorRole.ADJ],
  authorityLimitMinor: null as string | null,
};
const LEAD = { ...ADJUDICATOR, operatorId: 'op_2', subject: 'sam@', roles: [OperatorRole.ADJL] };

function build() {
  const dataSource = new FakeDataSource();
  const entries = new FakeEntries();
  const service = new OverrideLogService(dataSource as never, entries as never);
  return { dataSource, entries, service };
}

const BASE = {
  targetType: 'slash_proposal',
  targetId: 'p1',
  organizationId: 'org_1',
  reasonCode: 'MAPPING_REGRESSION',
  reason: 'x'.repeat(150),
};

describe('OverrideLogService', () => {
  /**
   * The property the whole override register turns on: the mutation and the register entry
   * commit together, or neither does. There is no ordering that leaves a change
   * with no record of who authorised it.
   */
  it('commits the mutation and the entry in one transaction', async () => {
    const { service, dataSource, entries } = build();

    const result = await service.perform(
      { code: 'S-3', actor: ADJUDICATOR, ...BASE },
      async () => ({
        value: 'done',
        before: { status: 'DISPUTED' },
        after: { status: 'UPHELD' },
      }),
    );

    expect(result).toBe('done');
    expect(dataSource.runner.committed).toBe(true);
    expect(dataSource.runner.rolledBack).toBe(false);
    expect(dataSource.runner.released).toBe(true);
    expect(entries.appended).toHaveLength(1);
    expect(entries.appended[0]).toMatchObject({
      code: 'S-3',
      family: 'S',
      action: 'dispute.decided',
      actorOperatorId: 'op_1',
      before: { status: 'DISPUTED' },
      after: { status: 'UPHELD' },
    });
  });

  /** A mutation that throws takes the entry with it. */
  it('rolls back the entry when the mutation fails', async () => {
    const { service, dataSource, entries } = build();

    await expect(
      service.perform({ code: 'S-3', actor: ADJUDICATOR, ...BASE }, async () => {
        throw new Error('constraint violation');
      }),
    ).rejects.toThrow('constraint violation');

    expect(dataSource.runner.rolledBack).toBe(true);
    expect(dataSource.runner.committed).toBe(false);
    expect(entries.appended).toHaveLength(0);
  });

  /**
   * And the direction that matters more: a failure to *record* rolls back the
   * change. An override that happened with no entry is the exact hole this
   * class exists to close.
   */
  it('rolls back the mutation when the entry cannot be written', async () => {
    const { service, dataSource, entries } = build();
    entries.throwOnAppend = true;

    await expect(
      service.perform({ code: 'S-3', actor: ADJUDICATOR, ...BASE }, async () => ({
        value: 'done',
        before: {},
        after: {},
      })),
    ).rejects.toThrow('append failed');

    expect(dataSource.runner.rolledBack).toBe(true);
    expect(dataSource.runner.committed).toBe(false);
  });

  it('refuses an unknown register code before touching the database', async () => {
    const { service, dataSource } = build();

    await expect(
      service.perform({ code: 'S-99', actor: ADJUDICATOR, ...BASE }, async () => ({
        value: null,
        before: {},
        after: {},
      })),
    ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_UNKNOWN_OVERRIDE_CODE });

    expect(dataSource.runner.started).toBe(false);
  });

  /**
   * A register row that is enumerated but not yet built. Refusing
   * here is what keeps `implemented: false` honest — otherwise the register
   * fills with entries for actions no code performs.
   */
  it('refuses a register row that has no implementation', async () => {
    const { service } = build();

    await expect(
      service.perform({ code: 'V-6', actor: LEAD, ...BASE }, async () => ({
        value: null,
        before: {},
        after: {},
      })),
    ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_OVERRIDE_NOT_IMPLEMENTED });
  });

  it('refuses an actor without one of the register row’s roles', async () => {
    const { service } = build();

    await expect(
      // `S-11` is ADJL only; this actor is ADJ.
      service.perform({ code: 'S-11', actor: ADJUDICATOR, ...BASE }, async () => ({
        value: null,
        before: {},
        after: {},
      })),
    ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_ROLE_REQUIRED });
  });

  describe('two-person rows', () => {
    it('refuses a two-person action with no approver', async () => {
      const { service } = build();

      await expect(
        service.perform({ code: 'S-11', actor: LEAD, ...BASE }, async () => ({
          value: null,
          before: {},
          after: {},
        })),
      ).rejects.toMatchObject({
        errorCode: OperatorErrorCode.OPERATOR_SECOND_APPROVER_REQUIRED,
      });
    });

    /** No self-approval, enforced in code. Also a CHECK constraint. */
    it('refuses an approver who is the actor', async () => {
      const { service } = build();

      await expect(
        service.perform({ code: 'S-11', actor: LEAD, approver: LEAD, ...BASE }, async () => ({
          value: null,
          before: {},
          after: {},
        })),
      ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_SELF_APPROVAL_REFUSED });
    });

    it('records the checker and the mode when a second identity is supplied', async () => {
      const { service, entries } = build();

      await service.perform(
        {
          code: 'S-11',
          actor: LEAD,
          approver: { ...ADJUDICATOR, roles: [OperatorRole.ADJL] },
          ...BASE,
        },
        async () => ({ value: null, before: {}, after: {} }),
      );

      expect(entries.appended[0]).toMatchObject({
        approvalMode: ApprovalMode.TWO_PERSON,
        approverOperatorId: 'op_1',
        breakGlass: false,
      });
    });

    /**
     * A fleet sweep applies one conclusion to providers who never complained,
     * so its checker has to be somebody who can read a case: an adjudicator or
     * an adjudication lead. Authenticating as *an* operator is not enough.
     */
    describe('the fleet sweep approver (S-11)', () => {
      const perform = (service: OverrideLogService, roles: OperatorRole[]) =>
        service.perform(
          { code: 'S-11', actor: LEAD, approver: { ...ADJUDICATOR, roles }, ...BASE },
          async () => ({ value: null, before: {}, after: {} }),
        );

      it.each([
        [[OperatorRole.POL]],
        [[OperatorRole.SRE]],
        [[OperatorRole.TRE, OperatorRole.SUP]],
        [[]],
      ])('refuses an approver holding %j, before touching the database', async (roles) => {
        const { service, dataSource, entries } = build();

        await expect(perform(service, roles)).rejects.toMatchObject({
          errorCode: OperatorErrorCode.OPERATOR_APPROVER_ROLE_REQUIRED,
          statusCode: 403,
          message: expect.stringContaining('ADJ, ADJL'),
        });
        expect(dataSource.runner.started).toBe(false);
        expect(entries.appended).toEqual([]);
      });

      it.each([
        [[OperatorRole.ADJ]],
        [[OperatorRole.ADJL]],
        [[OperatorRole.SRE, OperatorRole.ADJ]],
      ])('accepts an approver holding %j', async (roles) => {
        const { service, entries } = build();

        await perform(service, roles);

        expect(entries.appended[0]).toMatchObject({
          code: 'S-11',
          approvalMode: ApprovalMode.TWO_PERSON,
          approverOperatorId: 'op_1',
        });
      });

      it('still answers "no approver" and "self approval" before the role', async () => {
        const { service } = build();

        await expect(
          service.perform({ code: 'S-11', actor: LEAD, ...BASE }, async () => ({
            value: null,
            before: {},
            after: {},
          })),
        ).rejects.toMatchObject({
          errorCode: OperatorErrorCode.OPERATOR_SECOND_APPROVER_REQUIRED,
        });
        await expect(
          service.perform(
            {
              code: 'S-11',
              actor: { ...LEAD, roles: [OperatorRole.ADJL] },
              approver: LEAD,
              ...BASE,
            },
            async () => ({ value: null, before: {}, after: {} }),
          ),
        ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_SELF_APPROVAL_REFUSED });
      });
    });

    /** A row that names no approver roles keeps the rule it always had. */
    it('leaves the other two-person action (S-5) open to any second operator', async () => {
      const { service, entries } = build();

      await service.perform(
        {
          code: 'S-5',
          actor: LEAD,
          approver: { ...ADJUDICATOR, roles: [OperatorRole.POL] },
          ...BASE,
        },
        async () => ({ value: null, before: {}, after: {} }),
      );

      expect(entries.appended[0]).toMatchObject({
        code: 'S-5',
        approvalMode: ApprovalMode.TWO_PERSON,
        approverOperatorId: 'op_1',
      });
    });

    it('names approver roles on the fleet sweep row and on no other', () => {
      expect(OVERRIDE_REGISTER['S-11'].approverRoles).toEqual([
        OperatorRole.ADJ,
        OperatorRole.ADJL,
      ]);
      expect(
        Object.values(OVERRIDE_REGISTER)
          .filter((row) => row.approverRoles !== undefined)
          .map((row) => row.code),
      ).toEqual(['S-11']);
    });
  });

  /**
   * Authority is bounded by a number, not by a role. Without that,
   * "support can issue a credit" is an unbounded withdrawal authority on a
   * custodial balance.
   */
  describe('authority limits', () => {
    it('refuses an amount above the actor’s ceiling', async () => {
      const { service } = build();
      const bounded = { ...ADJUDICATOR, authorityLimitMinor: '1000000' };

      await expect(
        service.perform(
          { code: 'S-3', actor: bounded, amountMinor: '5000000', ...BASE },
          async () => ({ value: null, before: {}, after: {} }),
        ),
      ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_AUTHORITY_EXCEEDED });
    });

    it('allows an action that moves no money regardless of the ceiling', async () => {
      const { service, entries } = build();
      const bounded = { ...ADJUDICATOR, authorityLimitMinor: '0' };

      await service.perform({ code: 'S-3', actor: bounded, ...BASE }, async () => ({
        value: null,
        before: {},
        after: {},
      }));

      expect(entries.appended).toHaveLength(1);
    });
  });

  /**
   * Break-glass is allowed and always reviewed. It moves the audit from before
   * the fact to after it; it does not remove it. What makes that real is that
   * the row is distinguishable forever.
   */
  it('marks a break-glass action as such', async () => {
    const { service, entries } = build();

    await service.perform(
      { code: 'S-1', actor: ADJUDICATOR, breakGlass: true, ...BASE },
      async () => ({ value: null, before: {}, after: {} }),
    );

    expect(entries.appended[0]).toMatchObject({
      approvalMode: ApprovalMode.BREAK_GLASS,
      breakGlass: true,
    });
  });
});
