import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { ArbitrationOutcome, ResolutionKind } from '@modules/slash/domain/arbitration';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';
import { SlashErrorCode } from '@modules/slash/errors/slash.errors';
import { ArbitrationService } from '@modules/slash/services/arbitration.service';
import { SlashProposalService } from '@modules/slash/services/slash-proposal.service';

import {
  FakeNotifications,
  FakeSlashEvents,
  FakeSlashProposals,
  TEST_SLASH_CONFIG,
} from './helpers/fake-slash-repositories';

/**
 * A query runner that applies its writes to the same in-memory rows the
 * repository fake holds, so a test can read the outcome rather than assert that
 * a method was called.
 */
class FakeTxManager {
  constructor(
    private readonly proposals: FakeSlashProposals,
    private readonly disputes: Map<string, DisputeEntity>,
  ) {}

  createQueryBuilder() {
    let patch: Record<string, unknown> = {};
    let expectedFrom: string[] = [];
    let id = '';
    // `extendDeadline` puts the chain clocks in the write's own WHERE clause, so
    // the fake has to evaluate them: a fake that ignored the predicate would
    // pass a test for a CAS that does not exist.
    let executionAtGuard: Date | null = null;
    const builder = {
      update: () => builder,
      set: (values: Record<string, unknown>) => {
        patch = values;
        return builder;
      },
      where: () => builder,
      andWhere: (_clause: string, params?: Record<string, unknown>) => {
        if (params?.proposalId) id = params.proposalId as string;
        if (params?.expectedFrom) expectedFrom = params.expectedFrom as string[];
        if (params?.executionAtGuard) executionAtGuard = params.executionAtGuard as Date;
        return builder;
      },
      execute: async () => {
        const row = this.proposals.rows.get(id);
        if (!row || !expectedFrom.includes(row.status)) return { affected: 0 };
        if (executionAtGuard) {
          // `chain_status <> 'PROPOSING'`
          if (row.chainStatus === 'PROPOSING') return { affected: 0 };
          // `(chain_status <> 'PENDING' OR chain_executable_at >= :guard)`,
          // including SQL's NULL comparison: a PENDING mirror with no clock
          // matches nothing and the write fails closed.
          if (
            row.chainStatus === 'PENDING' &&
            !(
              row.chainExecutableAt &&
              row.chainExecutableAt.getTime() >= (executionAtGuard as Date).getTime()
            )
          ) {
            return { affected: 0 };
          }
        }
        Object.assign(row, patch);
        return { affected: 1 };
      },
    };
    return builder;
  }

  async update(entity: unknown, criteria: { id: string }, patch: Record<string, unknown>) {
    const dispute = this.disputes.get(criteria.id);
    if (dispute) Object.assign(dispute, patch);
    return { affected: dispute ? 1 : 0 };
  }

  async findOneOrFail(_entity: unknown, options: { where: { id: string } }) {
    return this.proposals.rows.get(options.where.id) as SlashProposalEntity;
  }
}

/**
 * A recording `SlashExecutionService`.
 *
 * The chain half is not the subject here: what these tests assert is that a
 * decision which stops a judgement standing off-chain also stops it standing
 * ON chain, and which of the two calls it makes.
 */
class FakeSlashExecution {
  readonly adminCancelRequests: { organizationId: string; proposalId: string; reason: string }[] =
    [];
  readonly reproposeCalls: { organizationId: string; proposalId: string }[] = [];
  /** Settable so a test can prove a failed chain call cannot fail a committed decision. */
  throws: Error | null = null;

  /**
   * Lean v3's `cancel_slash` is signed by `Config.admin`, so a decision can
   * only RECORD that the reservation should go. What used to complete inside
   * this request is now `SlashLifecycleJob`'s admin-cancel sweep.
   */
  async requestAdminCancel(organizationId: string, proposalId: string, reason: string) {
    if (this.throws) throw this.throws;
    this.adminCancelRequests.push({ organizationId, proposalId, reason });
  }

  async reproposeAtRevisedPenalty(organizationId: string, proposalId: string) {
    if (this.throws) throw this.throws;
    this.reproposeCalls.push({ organizationId, proposalId });
  }
}

class PassThroughOverrideLog {
  readonly performed: { code: string; reason: string }[] = [];
  /**
   * Fires after the service has read the row and before its transaction runs —
   * the interval a concurrent sweep actually lands in. Settable so a test can
   * prove the write's own `WHERE` clause catches what the pre-read guard cannot.
   */
  beforeMutation: (() => void) | null = null;

  constructor(private readonly manager: FakeTxManager) {}

  async perform<T>(
    context: { code: string; reason: string },
    mutation: (qr: { manager: FakeTxManager }) => Promise<{ value: T }>,
  ): Promise<T> {
    this.performed.push({ code: context.code, reason: context.reason });
    this.beforeMutation?.();
    const result = await mutation({ manager: this.manager });
    return result.value;
  }
}

const ADJUDICATOR = {
  operatorId: 'op_1',
  subject: 'dan@',
  displayName: 'Dan',
  email: 'dan@example.test',
  roles: [],
  authorityLimitMinor: null,
};
const SECOND = { ...ADJUDICATOR, operatorId: 'op_2', subject: 'sam@' };

const NOTE =
  'The v2 to v3 binding change narrowed the item template and dropped items without a ' +
  'url field, so the failures are our mapping defect rather than a change in the data.';

function build(config = TEST_SLASH_CONFIG) {
  const proposals = new FakeSlashProposals();
  const events = new FakeSlashEvents();
  const notifications = new FakeNotifications();
  const disputes = new Map<string, DisputeEntity>();

  const disputeRepo = {
    save: async (row: DisputeEntity) => {
      row.id = row.id ?? `d_${disputes.size + 1}`;
      disputes.set(row.id, row);
      return row;
    },
    update: async (criteria: { id: string }, patch: Record<string, unknown>) => {
      const row = disputes.get(criteria.id);
      if (row) Object.assign(row, patch);
      return { affected: row ? 1 : 0 };
    },
    findOneBy: async (where: { id: string }) => disputes.get(where.id) ?? null,
  };

  const manager = new FakeTxManager(proposals, disputes);
  const overrides = new PassThroughOverrideLog(manager);
  const execution = new FakeSlashExecution();

  const lifecycle = new SlashProposalService(
    proposals as never,
    events as never,
    notifications as never,
    config,
  );
  const service = new ArbitrationService(
    proposals as never,
    disputeRepo as never,
    {} as never,
    lifecycle,
    overrides as never,
    notifications as never,
    config,
    execution as never,
  );

  return { proposals, events, notifications, disputes, overrides, execution, service };
}

/**
 * The default penalty is deliberately BELOW `secondSignatureThresholdMinor`
 * ($2.50), so a test that does not care about the second signature gets a decision that
 * binds immediately. Tests about the second signature set the amount, or the
 * threshold, explicitly.
 */
function seedDisputed(ctx: ReturnType<typeof build>, penaltyAmount = '1000000') {
  const dispute = Object.assign(new DisputeEntity(), {
    id: 'd_1',
    organizationId: 'org_1',
    subjectType: 'SLASH_PROPOSAL',
    subjectId: 'p1',
    state: 'OPEN',
  });
  ctx.disputes.set('d_1', dispute);
  ctx.proposals.seed({
    id: 'p1',
    organizationId: 'org_1',
    status: SlashProposalStatus.DISPUTED,
    disputeId: 'd_1',
    penaltyAmount,
  });
  return dispute;
}

describe('ArbitrationService', () => {
  describe('deciding a case', () => {
    /**
     * The polarity flip, end to end: the *proposal* is overturned, so the
     * *objection* is upheld. Getting this backwards would tell a provider they
     * won a case they lost.
     */
    it('overturns the proposal and upholds the objection', async () => {
      const ctx = build();
      const dispute = seedDisputed(ctx);

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_GRIEFING,
        reasonCodes: ['SINGLE_AGENT_CONCENTRATION'],
        note: NOTE,
      });

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.OVERTURNED);
      expect(row.outcome).toBe(ArbitrationOutcome.OVERTURNED_GRIEFING);
      expect(row.resolutionKind).toBe(ResolutionKind.ADJUDICATOR);
      expect(row.decidedByOperatorId).toBe('op_1');
      expect(dispute.state).toBe('UPHELD');
      expect(ctx.overrides.performed).toEqual([{ code: 'S-3', reason: NOTE }]);
    });

    it('upholds the proposal and rejects the objection', async () => {
      const ctx = build();
      const dispute = seedDisputed(ctx);

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.UPHELD,
        reasonCodes: ['RATE_GENUINELY_EXCEEDED'],
        note: NOTE,
      });

      expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.UPHELD);
      expect(dispute.state).toBe('REJECTED');
    });

    it('refuses a reason code that belongs to another outcome', async () => {
      const ctx = build();
      seedDisputed(ctx);

      await expect(
        ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
          outcome: ArbitrationOutcome.UPHELD,
          reasonCodes: ['MAPPING_REGRESSION'],
          note: NOTE,
        }),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_INVALID_REASON_CODE });
    });

    /**
     * An adjudicator may reduce a penalty and may never raise one. The provider
     * was given a window to answer a number; raising it on review would mean
     * the thing they answered is not the thing that happens to them.
     */
    it('refuses a recalculation above the proposed amount', async () => {
      const ctx = build();
      seedDisputed(ctx, '2000000');

      await expect(
        ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
          outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
          reasonCodes: ['PRICE_BASIS_WRONG'],
          note: NOTE,
          recalculatedAmount: '9000000',
        }),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_RECALCULATION_EXCEEDS_ORIGINAL,
      });
    });

    /**
     * The DTO refuses these first. The service refuses them again because it is
     * the one that calls `BigInt()` and writes the penalty, and `BigInt('')` is
     * `0n`: from DISPUTED an unchecked `''`, `'0'` or `'-5'` was written as the
     * penalty and the case re-proposed on chain at that figure.
     */
    it.each(['', '0', '-5', '284.7', 'abc', ' 100', '0100', null, undefined])(
      'refuses the recalculated amount %p before anything is written',
      async (recalculatedAmount) => {
        const ctx = build();
        const dispute = seedDisputed(ctx, '2000000');

        await expect(
          ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
            outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
            reasonCodes: ['PRICE_BASIS_WRONG'],
            note: NOTE,
            recalculatedAmount,
          }),
        ).rejects.toMatchObject({
          errorCode: SlashErrorCode.SLASH_RECALCULATED_AMOUNT_INVALID,
          statusCode: 422,
        });

        const row = ctx.proposals.rows.get('p1')!;
        expect(row.status).toBe(SlashProposalStatus.DISPUTED);
        expect(row.penaltyAmount).toBe('2000000');
        expect(dispute.state).toBe('OPEN');
        expect(ctx.overrides.performed).toEqual([]);
        expect(ctx.execution.reproposeCalls).toEqual([]);
        expect(ctx.events.kinds()).toEqual([]);
      },
    );

    it('says what the amount must be, not that a reason code is wrong', async () => {
      const ctx = build();
      seedDisputed(ctx, '2000000');

      await expect(
        ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
          outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
          reasonCodes: ['PRICE_BASIS_WRONG'],
          note: NOTE,
        }),
      ).rejects.toMatchObject({
        message:
          'UPHELD_RECALCULATED needs a recalculated penalty: a positive whole number of minor ' +
          'units, no more than the proposed 2000000',
      });
    });

    /** "May not exceed": the console's own rule, so the two agree at the boundary. */
    it('accepts a recalculation equal to the proposed amount', async () => {
      const ctx = build();
      seedDisputed(ctx, '2000000');

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
        reasonCodes: ['PRICE_BASIS_WRONG'],
        note: NOTE,
        recalculatedAmount: '2000000',
      });

      expect(ctx.proposals.rows.get('p1')!.penaltyAmount).toBe('2000000');
    });

    it('accepts a recalculation below the proposed amount', async () => {
      const ctx = build();
      const dispute = seedDisputed(ctx, '2000000');

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
        reasonCodes: ['PRICE_BASIS_WRONG'],
        note: NOTE,
        recalculatedAmount: '1000000',
      });

      expect(ctx.proposals.rows.get('p1')!.penaltyAmount).toBe('1000000');
      expect(dispute.state).toBe('PARTIALLY_UPHELD');
    });

    it('records the false-positive flag off the outcome, not off the decision', async () => {
      const ctx = build();
      seedDisputed(ctx);

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_GRIEFING,
        reasonCodes: ['SINGLE_AGENT_CONCENTRATION'],
        note: NOTE,
      });

      // Griefing is not our error: the measurement was right and a third party
      // caused it. Counting it would make our own metric move whenever somebody
      // attacked a provider.
      expect(ctx.proposals.rows.get('p1')!.countsAsFalsePositive).toBe(false);
    });
  });

  /** The second signature on large or sweep-opening decisions. */
  describe('the second signature', () => {
    it('holds a sweep-opening overturn at AWAITING_SECOND regardless of amount', async () => {
      const ctx = build();
      seedDisputed(ctx, '1');

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        reasonCodes: ['MAPPING_REGRESSION'],
        note: NOTE,
      });

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.AWAITING_SECOND);
      // Not resolved yet: a decision awaiting a countersignature has resolved
      // nothing, and the CHECK constraint would refuse the row if it claimed to.
      expect(row.resolvedAt).toBeNull();
    });

    it('holds any decision at or above the materiality threshold', async () => {
      const ctx = build({ ...TEST_SLASH_CONFIG, secondSignatureThresholdMinor: '5000000' });
      seedDisputed(ctx, '5000000');

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.UPHELD,
        reasonCodes: ['RATE_GENUINELY_EXCEEDED'],
        note: NOTE,
      });

      expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.AWAITING_SECOND);
    });

    it('binds the decision when a different operator countersigns', async () => {
      const ctx = build();
      const dispute = seedDisputed(ctx, '1');
      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        reasonCodes: ['MAPPING_REGRESSION'],
        note: NOTE,
      });

      await ctx.service.second(SECOND as never, 'org_1', 'p1', 'SIGNED', 'agreed, ours');

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.OVERTURNED);
      expect(row.secondedByOperatorId).toBe('op_2');
      expect(row.resolvedAt).not.toBeNull();
      expect(dispute.state).toBe('UPHELD');
      expect(ctx.overrides.performed.map((p) => p.code)).toEqual(['S-3', 'S-12']);
    });

    it('refuses a countersignature from the operator who decided', async () => {
      const ctx = build();
      seedDisputed(ctx, '1');
      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        reasonCodes: ['MAPPING_REGRESSION'],
        note: NOTE,
      });

      await expect(
        ctx.service.second(ADJUDICATOR as never, 'org_1', 'p1', 'SIGNED', 'agreed with myself'),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_SECOND_READER_MUST_DIFFER });
    });

    it('refuses a decision from the operator who objected, before the database does', async () => {
      const ctx = build();
      seedDisputed(ctx, '1');
      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        reasonCodes: ['MAPPING_REGRESSION'],
        note: NOTE,
      });
      await ctx.service.second(SECOND as never, 'org_1', 'p1', 'OBJECTED', 'predates the change');

      await expect(
        ctx.service.decide(SECOND as never, 'org_1', 'p1', {
          outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
          reasonCodes: ['MAPPING_REGRESSION'],
          note: NOTE,
        }),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_SECOND_READER_MUST_DIFFER,
        statusCode: 409,
      });
      expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.UNDER_REVIEW);

      // A third reader (or the original decider) may still decide.
      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        reasonCodes: ['MAPPING_REGRESSION'],
        note: NOTE,
      });
      expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.AWAITING_SECOND);
    });

    /**
     * An objection returns the case to the queue undecided. Disagreement
     * escalates to an independent third reader, not to a negotiation between the
     * first two — and an objection that silently became a veto would let the
     * second reader decide every case they disagreed with without ever writing
     * a decision of their own.
     */
    it('returns the case to UNDER_REVIEW, undecided, when the second objects', async () => {
      const ctx = build();
      const dispute = seedDisputed(ctx, '1');
      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        reasonCodes: ['MAPPING_REGRESSION'],
        note: NOTE,
      });

      await ctx.service.second(
        SECOND as never,
        'org_1',
        'p1',
        'OBJECTED',
        'the failures predate the binding change',
      );

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.UNDER_REVIEW);
      expect(row.outcome).toBeNull();
      expect(row.resolutionKind).toBeNull();
      expect(row.decidedByOperatorId).toBeNull();
      expect(row.resolvedAt).toBeNull();
      expect(dispute.state).toBe('UNDER_REVIEW');
    });

    it('refuses a countersignature on a case that is not awaiting one', async () => {
      const ctx = build();
      seedDisputed(ctx);

      await expect(
        ctx.service.second(SECOND as never, 'org_1', 'p1', 'SIGNED', 'nothing to sign'),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_SECOND_SIGNATURE_NOT_PENDING,
      });
    });
  });

  /**
   * The chain does not know a human decided.
   *
   * A standing `SlashRecord` keeps reserving the provider's stake until
   * somebody tells it, and `execute_slash` is permissionless once
   * `executable_at` passes. So an overturn recorded only in Postgres is an
   * overturn a stranger can still execute through, and that is what makes the
   * parallel clock safe rather than merely fast.
   */
  describe('what a decision does to the chain', () => {
    it('asks for the standing on-chain proposal to be cancelled when a case is overturned', async () => {
      const ctx = build();
      seedDisputed(ctx);

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_GRIEFING,
        reasonCodes: ['SINGLE_AGENT_CONCENTRATION'],
        note: NOTE,
      });

      expect(ctx.execution.adminCancelRequests).toEqual([
        { organizationId: 'org_1', proposalId: 'p1', reason: 'OVERTURNED_GRIEFING' },
      ]);
      expect(ctx.execution.reproposeCalls).toEqual([]);
      // And the provider is still told. The chain call is an addition to that
      // block, never a replacement for it.
      expect(ctx.notifications.sent.map((n) => n.event)).toContain('provider.slash_decided');
    });

    it('re-proposes at the revised figure rather than executing the frozen one', async () => {
      const ctx = build();
      seedDisputed(ctx, '2000000');

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
        reasonCodes: ['PRICE_BASIS_WRONG'],
        note: NOTE,
        recalculatedAmount: '400000',
      });

      expect(ctx.execution.reproposeCalls).toEqual([{ organizationId: 'org_1', proposalId: 'p1' }]);
      expect(ctx.execution.adminCancelRequests).toEqual([]);
      expect(ctx.notifications.sent.map((n) => n.event)).toContain('provider.slash_decided');
    });

    it('touches the chain for nothing that merely upholds the original figure', async () => {
      const ctx = build();
      seedDisputed(ctx);

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.UPHELD,
        reasonCodes: ['RATE_GENUINELY_EXCEEDED'],
        note: NOTE,
      });

      expect(ctx.execution.adminCancelRequests).toEqual([]);
      expect(ctx.execution.reproposeCalls).toEqual([]);
    });

    /**
     * A decision awaiting a countersignature has resolved nothing, so nothing
     * may be released on the strength of it. The chain call belongs to the act
     * that BINDS the decision, which for these cases is `second()`.
     */
    it('waits for the countersignature before it touches the chain', async () => {
      const ctx = build();
      seedDisputed(ctx, '1');

      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        reasonCodes: ['MAPPING_REGRESSION'],
        note: NOTE,
      });

      expect(ctx.execution.adminCancelRequests).toEqual([]);

      await ctx.service.second(SECOND as never, 'org_1', 'p1', 'SIGNED', 'agreed, ours');

      expect(ctx.execution.adminCancelRequests).toEqual([
        { organizationId: 'org_1', proposalId: 'p1', reason: 'OVERTURNED_PLATFORM_DEFECT' },
      ]);
      // `second()` reads the outcome from the dispute, not from an `input`, and
      // it still notifies. Both halves of that block survive.
      expect(ctx.notifications.sent.map((n) => n.event)).toContain('provider.slash_decided');
    });

    it('touches nothing when the second reader objects', async () => {
      const ctx = build();
      seedDisputed(ctx, '1');
      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        reasonCodes: ['MAPPING_REGRESSION'],
        note: NOTE,
      });

      await ctx.service.second(
        SECOND as never,
        'org_1',
        'p1',
        'OBJECTED',
        'the failures predate it',
      );

      expect(ctx.execution.adminCancelRequests).toEqual([]);
      expect(ctx.execution.reproposeCalls).toEqual([]);
    });

    /**
     * The override transaction has already committed by the time the chain is
     * reached. An exception escaping here would hand the operator a failure for
     * a decision that stands — and they would decide it again.
     */
    it('does not fail a committed decision when the chain call throws', async () => {
      const ctx = build();
      seedDisputed(ctx);
      ctx.execution.throws = new Error('no verifier signing capability in this process');

      await expect(
        ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
          outcome: ArbitrationOutcome.OVERTURNED_GRIEFING,
          reasonCodes: ['SINGLE_AGENT_CONCENTRATION'],
          note: NOTE,
        }),
      ).resolves.toBeDefined();

      expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.OVERTURNED);
    });
  });

  describe('suspending a case (S-1)', () => {
    /**
     * The two-phase slash added `EXECUTING → CANCELLED` for the chain-void path. `S-1` must
     * not inherit it: the record is `Pending` on chain and the transaction may
     * be in flight, so closing the case here would strand the provider's stake
     * reserved until `expire_slash` reaps it a week later — and would record a
     * suspension of an execution that can still land.
     */
    it('refuses to suspend a case whose execution is already in flight', async () => {
      const ctx = build();
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.EXECUTING,
      });

      await expect(
        ctx.service.suspend(ADJUDICATOR as never, 'org_1', 'p1', 'S1_OPERATOR_HOLD', NOTE),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION });

      expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.EXECUTING);
      // Refused before the override log is opened, so no S-1 entry is written
      // for a suspension that did not happen.
      expect(ctx.overrides.performed).toEqual([]);
    });

    /**
     * The guard is about `EXECUTING` and nothing else. An `UPHELD` case has no
     * transaction in flight and stays suspendable.
     */
    it('still suspends a case that has not started executing', async () => {
      const ctx = build();
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.UPHELD,
      });

      await ctx.service.suspend(ADJUDICATOR as never, 'org_1', 'p1', 'S1_OPERATOR_HOLD', NOTE);

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.CANCELLED);
      // The DB requires `(resolution_kind = 'ADJUDICATOR') = (outcome IS NOT NULL)`
      // and `(resolved_at IS NULL) = (resolution_kind IS NULL)`: a suspension has
      // no outcome, so it may be neither ADJUDICATOR nor carry a resolvedAt.
      expect(row.outcome ?? null).toBeNull();
      expect(row.resolutionKind ?? null).toBeNull();
      expect(row.resolvedAt ?? null).toBeNull();
      expect(ctx.overrides.performed).toEqual([{ code: 'S-1', reason: NOTE }]);
    });

    /**
     * A suspension recorded only in Postgres leaves the on-chain record
     * standing: the stake stays reserved and, once the timelock passes, anyone
     * may execute it. So it asks for the cancel exactly as an overturn does.
     */
    it('asks for the standing on-chain proposal to be cancelled', async () => {
      const ctx = build();
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.PROPOSED,
      });

      await ctx.service.suspend(ADJUDICATOR as never, 'org_1', 'p1', 'S1_OPERATOR_HOLD', NOTE);

      expect(ctx.execution.adminCancelRequests).toEqual([
        { organizationId: 'org_1', proposalId: 'p1', reason: 'SUSPENDED' },
      ]);
      expect(ctx.execution.reproposeCalls).toEqual([]);
    });

    it('asks for nothing when the suspension is refused', async () => {
      const ctx = build();
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.EXECUTING,
      });

      await expect(
        ctx.service.suspend(ADJUDICATOR as never, 'org_1', 'p1', 'S1_OPERATOR_HOLD', NOTE),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION });

      expect(ctx.execution.adminCancelRequests).toEqual([]);
    });

    /** The suspension has committed; a failed request is repaired by the lifecycle job. */
    it('does not fail a committed suspension when the cancel request throws', async () => {
      const ctx = build();
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.PROPOSED,
      });
      ctx.execution.throws = new Error('database unavailable');

      await expect(
        ctx.service.suspend(ADJUDICATOR as never, 'org_1', 'p1', 'S1_OPERATOR_HOLD', NOTE),
      ).resolves.toMatchObject({ status: SlashProposalStatus.CANCELLED });
    });
  });

  /**
   * `S-8`, and the one operator action that can outrun the chain.
   *
   * `execute_slash` is permissionless — its only signer is `payer` and the
   * handler consults it about nothing — so once the record's `executable_at`
   * passes, any stranger may take the penalty. That moment is frozen at propose
   * time and no off-chain write moves it, while `PROPOSED` is already a state in
   * which the record stands on chain (`findAwaitingChainProposal` gates on
   * `respond_by_at IS NOT NULL`, not on a status past `PROPOSED`).
   */
  describe('extending the response deadline', () => {
    const RESPOND_BY = new Date('2026-08-12T09:14:00Z');

    function seedProposed(ctx: ReturnType<typeof build>, overrides: Record<string, unknown> = {}) {
      return ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.PROPOSED,
        respondByAt: RESPOND_BY,
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
        ...overrides,
      });
    }

    it('moves both clocks when nothing is standing on chain', async () => {
      const ctx = build();
      seedProposed(ctx);

      await ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 48, 'S8_MORE', NOTE);

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.respondByAt!.toISOString()).toBe('2026-08-14T09:14:00.000Z');
      // The timelock moves with it: a window in which the provider may still
      // object and the penalty may already have executed is the one thing
      // slash case screen promises cannot happen.
      expect(row.earliestExecutionAt.toISOString()).toBe('2026-08-14T09:14:00.000Z');
      expect(ctx.overrides.performed).toEqual([{ code: 'S-8', reason: NOTE }]);
    });

    /**
     * The chain's door is at 12:00 on the 14th. An extension to 09:14 on the
     * 15th would promise the provider 21 hours they do not have, and neither
     * the boot assertion nor the `max(both clocks)` execute predicate can stop
     * a stranger walking through it — both constrain this backend, not the
     * world.
     */
    it('refuses an extension that runs past the chain executable moment', async () => {
      const ctx = build();
      seedProposed(ctx, {
        chainStatus: 'PENDING',
        chainProposedAt: new Date('2026-08-11T12:00:00Z'),
        chainExecutableAt: new Date('2026-08-14T12:00:00Z'),
      });

      await expect(
        ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 72, 'S8_MORE', NOTE),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_EXTENSION_EXCEEDS_CHAIN_TIMELOCK,
      });

      // Not clamped. An operator who asked for three days and silently got two
      // goes on telling the provider the longer number.
      const row = ctx.proposals.rows.get('p1')!;
      expect(row.respondByAt!.toISOString()).toBe(RESPOND_BY.toISOString());
      expect(row.earliestExecutionAt.toISOString()).toBe('2026-08-13T09:14:00.000Z');
      // Refused before the override log is opened, so no S-8 entry records an
      // extension that did not happen.
      expect(ctx.overrides.performed).toEqual([]);
    });

    /** Both timestamps are in the message, so the operator can see the gap. */
    it('names both moments in the refusal', async () => {
      const ctx = build();
      seedProposed(ctx, {
        chainStatus: 'PENDING',
        chainProposedAt: new Date('2026-08-11T12:00:00Z'),
        chainExecutableAt: new Date('2026-08-14T12:00:00Z'),
      });

      await expect(
        ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 72, 'S8_MORE', NOTE),
      ).rejects.toMatchObject({
        message: expect.stringContaining('2026-08-14T12:00:00.000Z'),
      });
      await expect(
        ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 72, 'S8_MORE', NOTE),
      ).rejects.toMatchObject({
        message: expect.stringContaining('2026-08-15T09:14:00.000Z'),
      });
    });

    /** An extension that lands inside the guard band is still granted. */
    it('allows an extension that stays inside the chain deadline', async () => {
      const ctx = build();
      seedProposed(ctx, {
        chainStatus: 'PENDING',
        chainProposedAt: new Date('2026-08-11T12:00:00Z'),
        chainExecutableAt: new Date('2026-08-14T12:00:00Z'),
      });

      await ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 48, 'S8_MORE', NOTE);

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.respondByAt!.toISOString()).toBe('2026-08-14T09:14:00.000Z');
      expect(row.earliestExecutionAt.toISOString()).toBe('2026-08-14T09:14:00.000Z');
    });

    /**
     * The guard keys on a LIVE record. A cancelled or expired one cannot be
     * executed by anybody, so there is no door to run past and the extension is
     * an ordinary date change.
     */
    it('does not refuse when no live record stands on chain', async () => {
      const ctx = build();
      seedProposed(ctx, {
        chainStatus: 'CANCELLED',
        chainProposedAt: new Date('2026-08-11T12:00:00Z'),
        chainExecutableAt: new Date('2026-08-14T12:00:00Z'),
      });

      await ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 120, 'S8_MORE', NOTE);

      expect(ctx.proposals.rows.get('p1')!.earliestExecutionAt.toISOString()).toBe(
        '2026-08-17T09:14:00.000Z',
      );
    });

    /**
     * `PROPOSING` is not a millisecond of transit. `proposeDue`'s non-void catch
     * deliberately leaves the row claimed and `PROPOSING` on any failure the
     * program did not name, precisely because the transaction may already have
     * landed — so the door can be real while the column is still null, for
     * `CHAIN_CLAIM_STALE_MS` (ten minutes) or for as long as an RPC outage
     * lasts. An unknown deadline is not a safe one.
     */
    it('refuses an extension while a proposal is being sent', async () => {
      const ctx = build();
      seedProposed(ctx, { chainStatus: 'PROPOSING', chainExecutableAt: null });

      await expect(
        ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 24, 'S8_MORE', NOTE),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_EXTENSION_WHILE_PROPOSING,
      });

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.respondByAt!.toISOString()).toBe(RESPOND_BY.toISOString());
      expect(ctx.overrides.performed).toEqual([]);
    });

    /**
     * The two refusals carry different remedies — "retry shortly" against
     * "this can never be granted" — so they must not collapse into one code.
     */
    it('separates the unknown deadline from the known one', async () => {
      const ctx = build();
      seedProposed(ctx, { chainStatus: 'PROPOSING', chainExecutableAt: null });

      await expect(
        ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 1, 'S8_MORE', NOTE),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_EXTENSION_WHILE_PROPOSING,
        // Even a one-hour extension, which no known deadline would refuse.
        message: expect.stringContaining('Try again once the send settles'),
      });
    });

    /**
     * The guard reads the row before the transaction opens, and `proposeDue`
     * runs every minute. A propose landing in that interval must lose the write,
     * not slip past a check that had already passed — which is only true if the
     * chain columns are in the write's own `WHERE` clause.
     */
    it('loses the write when a propose lands between the read and the update', async () => {
      const ctx = build();
      const row = seedProposed(ctx);

      // The row the guard reads says NONE: no record, no door, extension fine.
      // Between that read and the UPDATE, the sweep proposes and the door lands
      // an hour from now — well before the extension's new deadline.
      ctx.overrides.beforeMutation = () => {
        row.chainStatus = 'PENDING';
        row.chainProposedAt = new Date('2026-08-11T12:00:00Z');
        row.chainExecutableAt = new Date('2026-08-14T12:00:00Z');
      };

      await expect(
        ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 72, 'S8_MORE', NOTE),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_EXTENSION_EXCEEDS_CHAIN_TIMELOCK,
      });

      // And nothing was written: the CAS matched no row.
      expect(row.respondByAt!.toISOString()).toBe(RESPOND_BY.toISOString());
      expect(row.earliestExecutionAt.toISOString()).toBe('2026-08-13T09:14:00.000Z');
    });

    /** The same interval, the same predicate, the other refusal. */
    it('loses the write when a propose is claimed between the read and the update', async () => {
      const ctx = build();
      const row = seedProposed(ctx);
      ctx.overrides.beforeMutation = () => {
        row.chainStatus = 'PROPOSING';
      };

      await expect(
        ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 72, 'S8_MORE', NOTE),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_EXTENSION_WHILE_PROPOSING,
      });
      expect(row.respondByAt!.toISOString()).toBe(RESPOND_BY.toISOString());
    });

    /**
     * A `PENDING` mirror without its clock cannot happen —
     * `chk_slash_proposals_chain_pending_is_whole` refuses it — but the guard
     * and the `WHERE` clause must both fail CLOSED on it rather than treating an
     * unknown door as no door. In SQL that falls out of `NULL >= x` being NULL.
     */
    it('fails closed on a PENDING mirror with no recorded door', async () => {
      const ctx = build();
      seedProposed(ctx, { chainStatus: 'PENDING', chainExecutableAt: null });

      await expect(
        ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 1, 'S8_MORE', NOTE),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_EXTENSION_EXCEEDS_CHAIN_TIMELOCK,
      });
    });

    /** Extending a window that has closed is a re-opening, not an extension. */
    it('refuses on a case that has left PROPOSED', async () => {
      const ctx = build();
      seedProposed(ctx, { status: SlashProposalStatus.UPHELD });

      await expect(
        ctx.service.extendDeadline(ADJUDICATOR as never, 'org_1', 'p1', 24, 'S8_MORE', NOTE),
      ).rejects.toMatchObject({
        // Not `SLASH_PROPOSAL_NOT_DISPUTABLE`: extending a deadline is not
        // filing a dispute, and the operator is told which action was refused.
        errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION,
        statusCode: 409,
        message: 'Cannot extend the deadline while the case is UPHELD; only while it is PROPOSED',
      });
      expect(ctx.overrides.performed).toEqual([]);
    });
  });

  /**
   * Taking ownership. Exempt from the override register, so the status check
   * here is the only thing between a stray request and a resolved case.
   */
  describe('claiming a case', () => {
    function seedInStatus(ctx: ReturnType<typeof build>, status: SlashProposalStatus) {
      const dispute = seedDisputed(ctx);
      ctx.proposals.rows.get('p1')!.status = status;
      return dispute;
    }

    it('moves a DISPUTED case to UNDER_REVIEW and records the owner', async () => {
      const ctx = build();
      const dispute = seedDisputed(ctx);

      const claimed = await ctx.service.claim(ADJUDICATOR as never, 'org_1', 'p1');

      expect(claimed.status).toBe(SlashProposalStatus.UNDER_REVIEW);
      expect(dispute.state).toBe('UNDER_REVIEW');
      expect(dispute.assignedOperatorId).toBe('op_1');
      expect(ctx.events.kinds()).toEqual(['ASSIGNED']);
    });

    it('changes the owner of a case already UNDER_REVIEW and nothing else', async () => {
      const ctx = build();
      const dispute = seedInStatus(ctx, SlashProposalStatus.UNDER_REVIEW);
      dispute.state = 'UNDER_REVIEW';
      dispute.assignedOperatorId = 'op_1';

      const claimed = await ctx.service.claim(SECOND as never, 'org_1', 'p1');

      expect(claimed.status).toBe(SlashProposalStatus.UNDER_REVIEW);
      expect(dispute.state).toBe('UNDER_REVIEW');
      expect(dispute.assignedOperatorId).toBe('op_2');
      expect(ctx.proposals.transitions).toEqual([]);
    });

    it('changes only the owner while a decision awaits its second signature', async () => {
      const ctx = build();
      const dispute = seedDisputed(ctx, '9000000');
      await ctx.service.decide(ADJUDICATOR as never, 'org_1', 'p1', {
        outcome: ArbitrationOutcome.UPHELD,
        reasonCodes: ['RATE_GENUINELY_EXCEEDED'],
        note: NOTE,
      });
      const pending = { state: dispute.state, outcome: dispute.outcome };

      const claimed = await ctx.service.claim(SECOND as never, 'org_1', 'p1');

      expect(claimed.status).toBe(SlashProposalStatus.AWAITING_SECOND);
      expect(claimed.decidedByOperatorId).toBe('op_1');
      // The pending decision lives on the dispute row; a reclaim must not touch it.
      expect({ state: dispute.state, outcome: dispute.outcome }).toEqual(pending);
      expect(dispute.assignedOperatorId).toBe('op_2');
    });

    /**
     * The defect: `claim` guarded only its DISPUTED branch, so on a resolved
     * case it still rewrote the dispute to UNDER_REVIEW, replaced the owner and
     * appended an ASSIGNED event — reopening the objection of a case that had
     * been overturned, in the record the provider reads.
     */
    it.each([
      SlashProposalStatus.PROPOSED,
      SlashProposalStatus.UPHELD,
      SlashProposalStatus.OVERTURNED,
      SlashProposalStatus.EXECUTING,
      SlashProposalStatus.EXECUTED,
      SlashProposalStatus.REVERSED,
      SlashProposalStatus.WAIVED,
      SlashProposalStatus.CANCELLED,
    ])('refuses a %s case and writes nothing', async (status) => {
      const ctx = build();
      const dispute = seedInStatus(ctx, status);
      dispute.state = 'UPHELD';
      dispute.assignedOperatorId = 'op_9';

      await expect(ctx.service.claim(ADJUDICATOR as never, 'org_1', 'p1')).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION,
        statusCode: 409,
        message:
          `Cannot claim the case while the case is ${status}; only while it is DISPUTED, ` +
          `UNDER_REVIEW or AWAITING_SECOND`,
      });

      expect(ctx.proposals.rows.get('p1')!.status).toBe(status);
      expect(dispute.state).toBe('UPHELD');
      expect(dispute.assignedOperatorId).toBe('op_9');
      expect(ctx.events.kinds()).toEqual([]);
      expect(ctx.proposals.transitions).toEqual([]);
    });

    it('writes nothing when the case leaves DISPUTED between the read and the claim', async () => {
      const ctx = build();
      const dispute = seedDisputed(ctx);
      const original = ctx.proposals.transitionIfIn.bind(ctx.proposals);
      ctx.proposals.transitionIfIn = async (...args: Parameters<typeof original>) => {
        ctx.proposals.rows.get('p1')!.status = SlashProposalStatus.OVERTURNED;
        return original(...args);
      };

      await expect(ctx.service.claim(ADJUDICATOR as never, 'org_1', 'p1')).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION,
      });
      expect(dispute.state).toBe('OPEN');
      expect(dispute.assignedOperatorId).toBeUndefined();
      expect(ctx.events.kinds()).toEqual([]);
    });
  });
});
