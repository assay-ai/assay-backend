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
  readonly manager = {};
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

/** The queue's approval rows, as far as `perform` touches them. */
class FakeApprovals {
  claimable = true;
  readonly claims: { id: string; requestedBy: string; approvedBy: string }[] = [];

  async markApproved(_manager: unknown, id: string, requestedBy: string, approvedBy: string) {
    this.claims.push({ id, requestedBy, approvedBy });
    return this.claimable;
  }
}

// `approvalId` makes each of these usable as an approver; on an actor it is ignored.
const ADJUDICATOR = {
  operatorId: 'op_1',
  subject: 'dan@',
  displayName: 'Dan',
  email: 'dan@example.test',
  roles: [OperatorRole.ADJ],
  authorityLimitMinor: null as string | null,
  approvalId: 'appr_1',
};
const LEAD = { ...ADJUDICATOR, operatorId: 'op_2', subject: 'sam@', roles: [OperatorRole.ADJL] };

function build() {
  const dataSource = new FakeDataSource();
  const entries = new FakeEntries();
  const approvals = new FakeApprovals();
  const service = new OverrideLogService(dataSource as never, entries as never, approvals as never);
  return { dataSource, entries, approvals, service };
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
      { code: 'S-14', actor: ADJUDICATOR, ...BASE },
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
      code: 'S-14',
      family: 'S',
      action: 'call_dispute.decided',
      actorOperatorId: 'op_1',
      before: { status: 'DISPUTED' },
      after: { status: 'UPHELD' },
    });
  });

  /** A mutation that throws takes the entry with it. */
  it('rolls back the entry when the mutation fails', async () => {
    const { service, dataSource, entries } = build();

    await expect(
      service.perform({ code: 'S-14', actor: ADJUDICATOR, ...BASE }, async () => {
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
      service.perform({ code: 'S-14', actor: ADJUDICATOR, ...BASE }, async () => ({
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
      // `S-17` is ADJL or TRE only; this actor is ADJ.
      service.perform({ code: 'S-17', actor: ADJUDICATOR, ...BASE }, async () => ({
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
        service.perform({ code: 'S-17', actor: LEAD, ...BASE }, async () => ({
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
        service.perform({ code: 'S-17', actor: LEAD, approver: LEAD, ...BASE }, async () => ({
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
          code: 'S-17',
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
     * A re-proposal takes a provider's stake again, so its checker has to be
     * somebody who can read a case: an adjudicator or an adjudication lead.
     * Authenticating as *an* operator is not enough.
     */
    describe('an approver drawn from the adjudicators (S-17)', () => {
      const perform = (service: OverrideLogService, roles: OperatorRole[]) =>
        service.perform(
          { code: 'S-17', actor: LEAD, approver: { ...ADJUDICATOR, roles }, ...BASE },
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
          code: 'S-17',
          approvalMode: ApprovalMode.TWO_PERSON,
          approverOperatorId: 'op_1',
        });
      });

      it('still answers "no approver" and "self approval" before the role', async () => {
        const { service } = build();

        await expect(
          service.perform({ code: 'S-17', actor: LEAD, ...BASE }, async () => ({
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
              code: 'S-17',
              actor: { ...LEAD, roles: [OperatorRole.ADJL] },
              approver: LEAD,
              ...BASE,
            },
            async () => ({ value: null, before: {}, after: {} }),
          ),
        ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_SELF_APPROVAL_REFUSED });
      });
    });

    /**
     * Recording a compensation moves treasury money, so its checker has to be
     * one of the roles that may record it — and has to be allowed that amount.
     */
    describe('the compensation approver (S-5)', () => {
      const perform = (
        service: OverrideLogService,
        approver: Partial<typeof ADJUDICATOR>,
        amountMinor: string | null = '5000000',
      ) =>
        service.perform(
          {
            code: 'S-5',
            actor: LEAD,
            approver: { ...ADJUDICATOR, ...approver },
            amountMinor,
            ...BASE,
          },
          async () => ({ value: null, before: {}, after: {} }),
        );

      it.each([[[OperatorRole.POL]], [[OperatorRole.ADJ]], [[OperatorRole.SRE]], [[]]])(
        'refuses an approver holding %j',
        async (roles) => {
          const { service, dataSource } = build();

          await expect(perform(service, { roles })).rejects.toMatchObject({
            errorCode: OperatorErrorCode.OPERATOR_APPROVER_ROLE_REQUIRED,
            statusCode: 403,
            message: expect.stringContaining('ADJL, TRE'),
          });
          expect(dataSource.runner.started).toBe(false);
        },
      );

      it.each([[[OperatorRole.TRE]], [[OperatorRole.ADJL]]])(
        'accepts an approver holding %j',
        async (roles) => {
          const { service, entries } = build();

          await perform(service, { roles });

          expect(entries.appended[0]).toMatchObject({
            code: 'S-5',
            approvalMode: ApprovalMode.TWO_PERSON,
            approverOperatorId: 'op_1',
          });
        },
      );

      it('refuses an approver whose authority limit is below the amount', async () => {
        const { service, dataSource, entries } = build();

        await expect(
          perform(service, { roles: [OperatorRole.TRE], authorityLimitMinor: '4999999' }),
        ).rejects.toMatchObject({
          errorCode: OperatorErrorCode.OPERATOR_APPROVER_AUTHORITY_EXCEEDED,
          statusCode: 403,
          message: expect.stringContaining('4999999'),
        });
        expect(dataSource.runner.started).toBe(false);
        expect(entries.appended).toEqual([]);
      });

      it.each(['5000000', null])('accepts an approver whose limit is %s', async (limit) => {
        const { service, entries } = build();

        await perform(service, { roles: [OperatorRole.TRE], authorityLimitMinor: limit });

        expect(entries.appended).toHaveLength(1);
      });

      it('compares no limit when the action moves no money', async () => {
        const { service, entries } = build();

        await perform(service, { roles: [OperatorRole.TRE], authorityLimitMinor: '0' }, null);

        expect(entries.appended).toHaveLength(1);
      });
    });

    /**
     * `S-14` is single-person on the register and may be raised per
     * occurrence (`escalateToTwoPerson`); its checker must then be an
     * adjudicator.
     */
    describe('a single-person row raised to two-person (S-14)', () => {
      const perform = (
        service: OverrideLogService,
        context: { approver?: typeof ADJUDICATOR | null; escalateToTwoPerson?: boolean },
      ) =>
        service.perform(
          { code: 'S-14', actor: LEAD, amountMinor: '5000000', ...context, ...BASE },
          async () => ({ value: null, before: {}, after: {} }),
        );

      it('stays single-person when it is not raised', async () => {
        const { service, entries } = build();

        await perform(service, {});

        expect(entries.appended[0]).toMatchObject({
          approvalMode: ApprovalMode.SINGLE,
          approverOperatorId: null,
        });
      });

      it('refuses with no approver', async () => {
        const { service } = build();

        await expect(perform(service, { escalateToTwoPerson: true })).rejects.toMatchObject({
          errorCode: OperatorErrorCode.OPERATOR_SECOND_APPROVER_REQUIRED,
        });
      });

      it('refuses the actor as their own approver', async () => {
        const { service } = build();

        await expect(
          perform(service, { escalateToTwoPerson: true, approver: LEAD }),
        ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_SELF_APPROVAL_REFUSED });
      });

      it.each([[[OperatorRole.SRE]], [[OperatorRole.POL]], [[OperatorRole.TRE]]])(
        'refuses an approver holding %j',
        async (roles) => {
          const { service } = build();

          await expect(
            perform(service, { escalateToTwoPerson: true, approver: { ...ADJUDICATOR, roles } }),
          ).rejects.toMatchObject({
            errorCode: OperatorErrorCode.OPERATOR_APPROVER_ROLE_REQUIRED,
            message: expect.stringContaining('ADJ, ADJL'),
          });
        },
      );

      it('refuses an adjudicator whose authority limit is below the penalty', async () => {
        const { service } = build();

        await expect(
          perform(service, {
            escalateToTwoPerson: true,
            approver: { ...ADJUDICATOR, authorityLimitMinor: '1' },
          }),
        ).rejects.toMatchObject({
          errorCode: OperatorErrorCode.OPERATOR_APPROVER_AUTHORITY_EXCEEDED,
        });
      });

      it('records the checker when an adjudicator within their limit approves', async () => {
        const { service, entries } = build();

        await perform(service, { escalateToTwoPerson: true, approver: ADJUDICATOR });

        expect(entries.appended[0]).toMatchObject({
          code: 'S-14',
          approvalMode: ApprovalMode.TWO_PERSON,
          approverOperatorId: 'op_1',
        });
      });
    });

    /**
     * No two-person occurrence may be approvable by "any second token": every
     * row that is two-person, or can be raised to it, names its approver roles.
     */
    it('names approver roles on every implemented row that can need an approver', () => {
      expect(OVERRIDE_REGISTER['S-17'].approverRoles).toEqual([
        OperatorRole.ADJ,
        OperatorRole.ADJL,
      ]);
      expect(OVERRIDE_REGISTER['S-5'].approverRoles).toEqual([OperatorRole.ADJL, OperatorRole.TRE]);
      expect(OVERRIDE_REGISTER['S-14'].approverRoles).toEqual([
        OperatorRole.ADJ,
        OperatorRole.ADJL,
      ]);
      expect(
        Object.values(OVERRIDE_REGISTER)
          .filter((row) => row.implemented && row.approval === ApprovalMode.TWO_PERSON)
          .filter((row) => row.approverRoles === undefined)
          .map((row) => row.code),
      ).toEqual([]);
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
          { code: 'S-14', actor: bounded, amountMinor: '5000000', ...BASE },
          async () => ({ value: null, before: {}, after: {} }),
        ),
      ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_AUTHORITY_EXCEEDED });
    });

    it('allows an action that moves no money regardless of the ceiling', async () => {
      const { service, entries } = build();
      const bounded = { ...ADJUDICATOR, authorityLimitMinor: '0' };

      await service.perform({ code: 'S-14', actor: bounded, ...BASE }, async () => ({
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
      { code: 'S-14', actor: ADJUDICATOR, breakGlass: true, ...BASE },
      async () => ({ value: null, before: {}, after: {} }),
    );

    expect(entries.appended[0]).toMatchObject({
      approvalMode: ApprovalMode.BREAK_GLASS,
      breakGlass: true,
    });
  });

  describe('the approvals queue', () => {
    it('marks the approval approved inside the action’s transaction', async () => {
      const { service, approvals, dataSource, entries } = build();

      await service.perform(
        {
          code: 'A-10',
          actor: { ...ADJUDICATOR, roles: [OperatorRole.SRE] },
          approver: LEAD,
          ...BASE,
        },
        async () => ({ value: null, before: {}, after: {} }),
      );

      expect(approvals.claims).toEqual([{ id: 'appr_1', requestedBy: 'op_1', approvedBy: 'op_2' }]);
      expect(dataSource.runner.committed).toBe(true);
      expect(entries.appended[0]).toMatchObject({ approverOperatorId: 'op_2' });
    });

    it('refuses, and writes nothing, when the approval is no longer pending', async () => {
      const { service, approvals, dataSource, entries } = build();
      approvals.claimable = false;
      const mutation = jest.fn(async () => ({ value: null, before: {}, after: {} }));

      await expect(
        service.perform(
          {
            code: 'A-10',
            actor: { ...ADJUDICATOR, roles: [OperatorRole.SRE] },
            approver: LEAD,
            ...BASE,
          },
          mutation,
        ),
      ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_APPROVAL_NOT_PENDING });

      expect(mutation).not.toHaveBeenCalled();
      expect(dataSource.runner.rolledBack).toBe(true);
      expect(entries.appended).toHaveLength(0);
    });
  });
});
