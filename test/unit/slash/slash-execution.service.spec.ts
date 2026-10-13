import { Logger } from '@nestjs/common';

import { DisputeEntity } from '@database/postgres/entities/dispute.entity';

import { ChainErrors } from '@modules/chains/errors/chains.errors';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { ArbitrationOutcome, ResolutionKind } from '@modules/slash/domain/arbitration';
import {
  SETTLEMENT_ERROR_CODE_BASE,
  SETTLEMENT_ERROR_NAMES,
} from '@modules/slash/domain/chain-slash-outcome';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { SlashErrorCode } from '@modules/slash/errors/slash.errors';
import {
  SlashCancelRequest,
  SlashCancelResult,
  SlashExecutionRequest,
  SlashExecutionResult,
  SlashExecutorPort,
  SlashProposalRequest,
  SlashProposalResult,
  SlashCancelIntent,
  SlashRecordSnapshot,
  oneByOne,
} from '@modules/slash/ports/slash-executor.port';
import { SlashExecutionService } from '@modules/slash/services/slash-execution.service';
import {
  deriveChainRequestId,
  SlashProposalService,
} from '@modules/slash/services/slash-proposal.service';

import { MoneyUtil } from '@shared/utils/money.util';

import {
  FakeNotifications,
  FakeSlashEvents,
  FakeSlashProposals,
  TEST_SLASH_CONFIG,
} from './helpers/fake-slash-repositories';

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET as AssetId;

/**
 * A recording executor.
 *
 * `appliedMinor` is settable so a test can exercise the case the real chain
 * produces and nothing else here would: the 10%-of-stake daily cap taking less
 * than the judgement asked for.
 */
class FakeExecutor implements SlashExecutorPort {
  readonly proposed: SlashProposalRequest[] = [];
  readonly executed: SlashExecutionRequest[] = [];
  readonly cancelBuilds: SlashCancelRequest[] = [];
  readonly expired: SlashCancelRequest[] = [];
  appliedMinor = '5000000';
  failNext = false;
  /** The chain's live slash delay; `null` = the namespace cannot say (Solana). */
  slashDelay: number | null = null;

  async slashDelaySeconds(): Promise<number | null> {
    return this.slashDelay;
  }

  /** Read only, and nothing in this suite resolves a beneficiary. */
  async settlementTreasury() {
    return 'solana:dev:Treasury3333' as AccountId;
  }

  /**
   * Phase one. `proposeImpl` is how a `proposeDue` case says what the chain
   * did — a fresh record, an adopted one, or a refusal — without this fake
   * growing a flag per outcome.
   */
  proposeImpl: ((request: SlashProposalRequest) => Promise<SlashProposalResult>) | null = null;

  async propose(request: SlashProposalRequest): Promise<SlashProposalResult> {
    this.proposed.push(request);
    if (this.proposeImpl) return this.proposeImpl(request);
    return {
      signature: `prop_${this.proposed.length}`,
      status: 'PENDING' as const,
      proposedAt: new Date('2026-08-10T09:15:00Z'),
      executableAt: new Date('2026-08-13T09:15:00Z'),
      reservedMinor: this.appliedMinor,
      adopted: false,
    };
  }

  /**
   * Lean v3's `cancel_slash` is the admin's, so this **builds** and never
   * submits. Nothing about the case changes because it was called.
   */
  async buildCancel(request: SlashCancelRequest): Promise<SlashCancelIntent> {
    this.cancelBuilds.push(request);
    return {
      transaction: `unsigned_cancel_${this.cancelBuilds.length}`,
      admin: 'Admin1111',
      requestId: request.requestId,
      provider: request.provider,
      blockhash: 'blockhash',
      lastValidBlockHeight: '100',
    };
  }

  /**
   * `expire_slash` — permissionless. Settable for the same reason `proposeImpl`
   * is: the interesting cases are the refusals.
   */
  expireImpl: ((request: SlashCancelRequest) => Promise<SlashCancelResult>) | null = null;

  async expire(request: SlashCancelRequest) {
    this.expired.push(request);
    if (this.expireImpl) return this.expireImpl(request);
    return { signature: `exp_${this.expired.length}`, cancelledAt: new Date() };
  }

  readonly recordReads: { requestId: string; provider: string }[] = [];

  /**
   * What the chain says about a record. Null by default — most cases here never
   * reach a recovery path — and settable so `reconcileExecuting` can be driven
   * through each of the three statuses a `SlashRecord` can hold.
   */
  readRecordImpl:
    | ((requestId: string, provider: string) => Promise<SlashRecordSnapshot | null>)
    | null = null;

  async readRecord(requestId: string, provider: string): Promise<SlashRecordSnapshot | null> {
    this.recordReads.push({ requestId, provider });
    if (this.readRecordImpl) return this.readRecordImpl(requestId, provider);
    return null;
  }

  /** Phase two, the same shape `proposeImpl` gives phase one. */
  executeImpl: ((request: SlashExecutionRequest) => Promise<SlashExecutionResult>) | null = null;

  async executeProposal(request: SlashExecutionRequest): Promise<SlashExecutionResult> {
    this.executed.push(request);
    if (this.executeImpl) return this.executeImpl(request);
    if (this.failNext) throw new Error('rpc timeout');
    return {
      signature: `sig_${this.executed.length}`,
      appliedMinor: this.appliedMinor,
      // The split the chain froze. 60/30 of `applied`, with the
      // remainder never taken; these are read, never recomputed, in production.
      agentAmountMinor: ((BigInt(this.appliedMinor) * 6000n) / 10000n).toString(),
      platformAmountMinor: ((BigInt(this.appliedMinor) * 3000n) / 10000n).toString(),
      executedAt: new Date('2026-08-13T09:15:00Z'),
    };
  }

  async proposeBatch(requests: readonly SlashProposalRequest[]) {
    return oneByOne(requests, (request) => this.propose(request));
  }

  async executeBatch(requests: readonly SlashExecutionRequest[]) {
    return oneByOne(requests, (request) => this.executeProposal(request));
  }
}

/** A pass-through override log, so the register is not the subject here. */
class FakeOverrideLog {
  readonly performed: string[] = [];
  readonly amounts: (string | null | undefined)[] = [];
  /**
   * The `before` snapshot each mutation hands back, which is what the register
   * records as the state the override moved the row out of. Captured because a
   * hard-coded `before` is a lie the register cannot detect on its own.
   */
  readonly befores: Record<string, unknown>[] = [];
  /** The `queryRunner.manager` handed to the last mutation. */
  lastManager: unknown = null;
  /** Every `manager.update` inside a mutation, in order: entity, criteria, patch. */
  readonly updates: { entity: unknown; criteria: unknown; patch: Record<string, unknown> }[] = [];

  async perform<T>(
    context: { code: string; amountMinor?: string | null },
    mutation: (qr: unknown) => Promise<{ value: T; before?: Record<string, unknown> }>,
  ): Promise<T> {
    this.performed.push(context.code);
    this.amounts.push(context.amountMinor);
    // `create` / `save` are here for `openSweep`, which builds a
    // `FleetSweepEntity` inside the override transaction. Additive: every other
    // caller in this suite only reaches `findOneOrFail`.
    const queryRunner = {
      manager: {
        findOneOrFail: async () => ({}),
        create: (_entity: unknown, data: Record<string, unknown>) => ({ ...data }),
        save: async (_entity: unknown, saved: Record<string, unknown>) => ({
          id: 'sweep_1',
          ...saved,
        }),
        update: async (entity: unknown, criteria: unknown, patch: Record<string, unknown>) => {
          this.updates.push({ entity, criteria, patch });
          return { affected: 1 };
        },
      },
    };
    this.lastManager = queryRunner.manager;
    const result = await mutation(queryRunner);
    if (result.before) this.befores.push(result.before);
    return result.value;
  }
}

const OPERATOR = {
  operatorId: 'op_1',
  subject: 'dan@',
  displayName: 'Dan',
  email: 'dan@example.test',
  roles: [],
  authorityLimitMinor: null,
};
const APPROVER = { ...OPERATOR, operatorId: 'op_2', subject: 'sam@' };

/**
 * `beneficiaries` defaults to **absent**, not to a stub: `SlashBeneficiaryService`
 * reads the chain, and the composition without it is the one the "no
 * beneficiary" refusals are about. A case that wants a resolver passes one.
 */
function build(
  options: {
    beneficiaries?: { resolve: jest.Mock };
    compensation?: { distribute: jest.Mock };
    /** What `confirmedDeposit` answers. `null` = "no such deposit on chain". */
    deposited?: Money | null;
  } = {},
) {
  const proposals = new FakeSlashProposals();
  // The executor is handed the provider's stake authority, not the org id, so
  // every construction needs the per-chain ENROLMENT row to resolve from.
  //
  // This fake answers any chain with the same row, and that is a deliberate
  // limit rather than an oversight: the cases in this file are about the slash
  // lifecycle, and their proposals carry several different assets. WHICH chain
  // the enrolment is read on is asserted in
  // `slash-beneficiary-stamping.spec.ts`, over a fake that answers only the
  // pair it was asked for — so a hardcoded chain dies there rather than
  // surviving both files.
  const enrolmentsRepo = {
    findOneBy: jest.fn().mockResolvedValue({
      organizationId: 'org-1',
      stakeAuthorityAccountId: 'solana:dev:StakeAuth9999',
    }),
  };
  const events = new FakeSlashEvents();
  const notifications = new FakeNotifications();
  const executor = new FakeExecutor();
  const overrides = new FakeOverrideLog();
  const sweeps = { complete: jest.fn(), fail: jest.fn() };
  /**
   * `StakeIntentBuilderPort` — the treasury's compensating `deposit_stake`.
   * `buildIntent` returns wire bytes nobody signs; `confirmedDeposit` is the
   * cluster read that turns an operator's signature into a fact.
   */
  const stakeIntents = {
    buildIntent: jest.fn().mockResolvedValue({
      transaction: {
        // The chain-family discriminants: `compensationIntent` narrows the union to its
        // solana member before reading wire bytes off it, so a fixture without
        // these is a fixture the narrowing correctly refuses.
        namespace: 'solana',
        chainId: CHAIN_IDS.SOLANA_DEVNET,
        kind: 'transaction',
        transactionBase64: 'unsigned_deposit',
        feePayer: 'Treasury3333',
        signers: ['Treasury3333'],
        blockhash: 'blockhash',
        lastValidBlockHeight: '100',
      },
      preflight: {},
    }),
    confirmedDeposit: jest
      .fn()
      .mockResolvedValue(
        options.deposited === undefined ? MoneyUtil.of('5000000', USDC, 6) : options.deposited,
      ),
  };

  const lifecycle = new SlashProposalService(
    proposals as never,
    events as never,
    notifications as never,
    TEST_SLASH_CONFIG,
  );
  const service = new SlashExecutionService(
    proposals as never,
    enrolmentsRepo as never,
    sweeps as never,
    lifecycle,
    overrides as never,
    notifications as never,
    TEST_SLASH_CONFIG,
    executor,
    (options.beneficiaries ?? null) as never,
    (options.compensation ?? null) as never,
    stakeIntents as never,
  );

  return {
    proposals,
    enrolments: enrolmentsRepo,
    events,
    notifications,
    executor,
    overrides,
    service,
    stakeIntents,
    beneficiaries: options.beneficiaries ?? null,
    compensation: options.compensation ?? null,
  };
}

describe('SlashExecutionService', () => {
  describe('execution', () => {
    it('writes back what the chain took, not what was asked for', async () => {
      const { service, proposals, executor } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.UPHELD,
        penaltyAmount: '10270000',
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
        // The case is only executable once the chain says so too.
        chainStatus: 'PENDING',
        chainProposedAt: new Date('2026-08-10T09:14:30Z'),
        chainExecutableAt: new Date('2026-08-13T09:14:30Z'),
      });
      // The cap bit: the judgement was 10.27, the chain took 5.00.
      executor.appliedMinor = '5000000';

      const result = await service.executeDue(new Date('2026-08-13T09:15:00Z'));

      expect(result).toEqual({ executed: 1, voided: 0, failed: 0 });
      const row = proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.EXECUTED);
      expect(row.appliedAmount).toBe('5000000');
      expect(row.penaltyAmount).toBe('10270000');
    });

    /** The slash case's promise, as a behaviour: nothing before the deadline. */
    it('does not execute before the timelock elapses', async () => {
      const { service, proposals, executor } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.UPHELD,
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
        // The chain has already opened; the promise on the screen has not.
        chainStatus: 'PENDING',
        chainProposedAt: new Date('2026-08-10T09:10:00Z'),
        chainExecutableAt: new Date('2026-08-13T09:10:00Z'),
      });

      const result = await service.executeDue(new Date('2026-08-13T09:13:00Z'));

      expect(result).toEqual({ executed: 0, voided: 0, failed: 0 });
      expect(executor.executed).toHaveLength(0);
      expect(proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.UPHELD);
    });

    /**
     * A failed submission returns the case to `UPHELD` so the next tick retries
     * it. The chain's own request-id lock is what makes that retry safe.
     */
    it('returns a failed case to UPHELD rather than leaving it stuck', async () => {
      const { service, proposals, executor } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.UPHELD,
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
        chainStatus: 'PENDING',
        chainProposedAt: new Date('2026-08-10T09:14:30Z'),
        chainExecutableAt: new Date('2026-08-13T09:14:30Z'),
      });
      // A refusal the program NAMED: the transaction was processed and
      // reverted, so nothing moved and the case may safely go back in the
      // queue. An unnamed failure is a different thing entirely — see
      // `executeDue — a failure the program did not name`.
      executor.executeImpl = async () => {
        throw ChainErrors.transactionFailed({
          instruction: 'execute_slash',
          signature: null,
          customErrorCode: codeOf('VerifierDailyCapExceeded'),
          reason: 'the daily cap for this verifier key is spent',
        });
      };

      const result = await service.executeDue(new Date('2026-08-13T09:15:00Z'));

      expect(result).toEqual({ executed: 0, voided: 0, failed: 1 });
      expect(proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.UPHELD);
    });

    /**
     * A window-level penalty is owed to every agent who spent in the window and
     * one attestation carries exactly one beneficiary. Refusing is the honest
     * answer; picking one agent would quietly settle a distribution question
     * the docs record as undecided.
     */
    it('refuses to execute a case with no beneficiary', async () => {
      const { service, proposals, executor } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.UPHELD,
        beneficiaryAccount: null,
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
        chainStatus: 'PENDING',
        chainProposedAt: new Date('2026-08-10T09:14:30Z'),
        chainExecutableAt: new Date('2026-08-13T09:14:30Z'),
      });

      const result = await service.executeDue(new Date('2026-08-13T09:15:00Z'));

      expect(executor.executed).toHaveLength(0);
      expect(result.executed).toBe(0);
    });
  });

  /**
   * Self-check #4 — *"Test: overturning the same verdict twice is blocked."*
   *
   * Three guards, and this exercises two of them from the outside. The third is
   * the program's own `SlashAlreadyReversed`, which is the only one that is
   * authoritative about money and cannot be reached from a unit test.
   */
  describe('compensation (`S-5`, in two steps)', () => {
    async function executed() {
      const ctx = build();
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.EXECUTED,
        appliedAmount: '5000000',
        executedAt: new Date('2026-08-13T09:15:00Z'),
        executionSignature: 'sig_1',
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
      });
      return ctx;
    }

    it('builds an unsigned deposit_stake from the treasury for exactly what was taken', async () => {
      // `reverse_slash` is gone. Putting a wrongly-taken penalty back is the
      // treasury depositing into the provider's own stake, and the treasury is
      // a multisig this backend holds no key for — so step one BUILDS and
      // changes nothing.
      const ctx = await executed();

      const intent = await ctx.service.compensationIntent('org_1', 'p1');

      expect(intent).toEqual({
        transaction: 'unsigned_deposit',
        provider: 'StakeAuth9999',
        amountMinor: '5000000',
        depositor: 'Treasury3333',
      });
      expect(ctx.stakeIntents.buildIntent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'DEPOSIT', funder: 'solana:dev:Treasury3333' }),
      );
      // Nothing on the case moved.
      expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.EXECUTED);
      expect(ctx.overrides.performed).toEqual([]);
    });

    it('records the compensation once the treasury signature is confirmed', async () => {
      const ctx = await executed();

      await ctx.service.markCompensated(
        OPERATOR as never,
        APPROVER as never,
        'org_1',
        'p1',
        'deposit-signature-1',
        'MAPPING_REGRESSION',
        'the binding change was ours',
      );

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.REVERSED);
      expect(row.reversalSignature).toBe('deposit-signature-1');
      // Review M-3: only a treasury deposit made after the slash executed counts.
      expect(ctx.stakeIntents.confirmedDeposit).toHaveBeenCalledWith(
        'deposit-signature-1',
        'solana:dev:StakeAuth9999',
        { funder: 'solana:dev:Treasury3333', after: row.executedAt },
      );
      expect(row.executedAt).toBeInstanceOf(Date);
      // And the status moves inside the override's own transaction.
      expect(ctx.proposals.reversalManagers).toEqual([ctx.overrides.lastManager]);
      expect(ctx.notifications.sent.map((n) => n.event)).toContain('provider.slash_reversed');
      expect(ctx.overrides.performed).toEqual(['S-5']);
    });

    it('refuses a signature the cluster does not show as a deposit at all', async () => {
      // The whole value of this route: without the read it would be a way to
      // mark a case compensated by typing a plausible string.
      const ctx = build({ deposited: null });
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.EXECUTED,
        appliedAmount: '5000000',
        executedAt: new Date('2026-08-13T09:15:00Z'),
        executionSignature: 'sig_1',
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
      });

      await expect(
        ctx.service.markCompensated(
          OPERATOR as never,
          APPROVER as never,
          'org_1',
          'p1',
          'not-a-real-signature',
          'MAPPING_REGRESSION',
          'trust me',
        ),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_COMPENSATION_NOT_CONFIRMED });

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.EXECUTED);
      expect(row.reversedAt).toBeNull();
      expect(ctx.notifications.sent).toHaveLength(0);
    });

    it('refuses a deposit smaller than what the chain took', async () => {
      const ctx = build({ deposited: MoneyUtil.of('4000000', USDC, 6) });
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.EXECUTED,
        appliedAmount: '5000000',
        executedAt: new Date('2026-08-13T09:15:00Z'),
        executionSignature: 'sig_1',
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
      });

      await expect(
        ctx.service.markCompensated(
          OPERATOR as never,
          APPROVER as never,
          'org_1',
          'p1',
          'short-deposit',
          'MAPPING_REGRESSION',
          'partial',
        ),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_COMPENSATION_NOT_CONFIRMED });
      expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.EXECUTED);
    });

    it('records the override with what the treasury actually deposited', async () => {
      // The override register's `amountMinor` is what an operator's authority
      // limit is checked against, so it has to be the money that really moved
      // rather than the figure the row said was owed.
      const ctx = build({ deposited: MoneyUtil.of('6000000', USDC, 6) });
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.EXECUTED,
        appliedAmount: '5000000',
        executedAt: new Date('2026-08-13T09:15:00Z'),
        executionSignature: 'sig_1',
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
      });

      await ctx.service.markCompensated(
        OPERATOR as never,
        APPROVER as never,
        'org_1',
        'p1',
        'generous-deposit',
        'MAPPING_REGRESSION',
        'the binding change was ours',
      );

      expect(ctx.overrides.amounts).toEqual(['6000000']);
    });

    it('refuses a second compensation of the same case', async () => {
      const ctx = await executed();
      await ctx.service.markCompensated(
        OPERATOR as never,
        APPROVER as never,
        'org_1',
        'p1',
        'deposit-signature-1',
        'MAPPING_REGRESSION',
        'the binding change was ours',
      );

      await expect(
        ctx.service.markCompensated(
          OPERATOR as never,
          APPROVER as never,
          'org_1',
          'p1',
          'deposit-signature-2',
          'MAPPING_REGRESSION',
          'trying again',
        ),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_ALREADY_REVERSED });
    });

    /**
     * The one row a compensation exists for.
     *
     * `execute_slash` is permissionless once `executable_at` passes, so between
     * an adjudicator overturning a case and the admin's `cancel_slash`
     * confirming, any stranger may spend the standing record.
     * `recordAnExecutionNobodyAskedFor` writes that honestly: the money columns
     * land, `status` stays `OVERTURNED` because a chain event must not
     * overwrite a human. The provider is then out of pocket for a judgement
     * that was overturned — and a guard reading `status === 'EXECUTED'` cannot
     * see them.
     */
    it('compensates an overturned case whose penalty the chain took anyway', async () => {
      const ctx = build();
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.OVERTURNED,
        outcome: 'OVERTURNED_PLATFORM_DEFECT',
        resolutionKind: 'ADJUDICATOR',
        decidedByOperatorId: 'op_1',
        resolvedAt: new Date('2026-08-13T09:10:00Z'),
        appliedAmount: '5000000',
        executedAt: new Date('2026-08-13T09:15:00Z'),
        executionSignature: null,
        chainStatus: 'EXECUTED',
        chainProposedAt: new Date('2026-08-10T09:14:30Z'),
        chainExecutableAt: new Date('2026-08-13T09:14:30Z'),
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
      });

      await ctx.service.markCompensated(
        OPERATOR as never,
        APPROVER as never,
        'org_1',
        'p1',
        'deposit-signature-1',
        'MAPPING_REGRESSION',
        'a stranger executed it after we overturned it',
      );

      const row = ctx.proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.REVERSED);
      // The register has to name the state the row was really in. Hard-coding
      // `EXECUTED` here would record an execution the adjudicator never
      // authorised as though it had been the platform's own.
      expect(ctx.overrides.befores).toEqual([
        { status: SlashProposalStatus.OVERTURNED, reversedAt: null },
      ]);
    });

    /**
     * A known gap, pinned so it is not mistaken for working: a SUSPENDED case
     * whose penalty a third party took before the cancel was signed is
     * recorded honestly (`recordAnExecutionNobodyAskedFor`), and the deposit
     * can be built, but recording the compensation needs a `CANCELLED →
     * REVERSED` edge the state machine does not have. No decision has been
     * taken to add it.
     */
    it('cannot yet record a compensation for a suspended case the chain executed', async () => {
      const ctx = build();
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.CANCELLED,
        appliedAmount: '5000000',
        executedAt: new Date('2026-08-13T09:15:00Z'),
        executionSignature: null,
        chainStatus: 'EXECUTED',
        chainProposedAt: new Date('2026-08-10T09:14:30Z'),
        chainExecutableAt: new Date('2026-08-13T09:14:30Z'),
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
      });

      await expect(ctx.service.compensationIntent('org_1', 'p1')).resolves.toMatchObject({
        amountMinor: '5000000',
      });
      await expect(
        ctx.service.markCompensated(
          OPERATOR as never,
          APPROVER as never,
          'org_1',
          'p1',
          'deposit-signature-1',
          'MAPPING_REGRESSION',
          'a third party executed it after we suspended it',
        ),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION });
      expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.CANCELLED);
      expect(ctx.overrides.performed).toEqual([]);
    });

    /**
     * The other half of the same predicate, and the half that must stay shut.
     * An overturn where nothing was taken has nothing to give back, and a
     * deposit built for it would pay a provider who was never charged.
     */
    it('still refuses an overturned case where nothing was ever taken', async () => {
      const ctx = build();
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.OVERTURNED,
        outcome: 'OVERTURNED_PLATFORM_DEFECT',
        resolutionKind: 'ADJUDICATOR',
        decidedByOperatorId: 'op_1',
        resolvedAt: new Date('2026-08-13T09:10:00Z'),
        chainStatus: 'CANCELLED',
      });

      await expect(ctx.service.compensationIntent('org_1', 'p1')).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_NOT_EXECUTED,
      });
      expect(ctx.stakeIntents.buildIntent).not.toHaveBeenCalled();
    });

    it('names the missing stake authority on an executed case, not "never executed"', async () => {
      const ctx = await executed();
      ctx.enrolments.findOneBy.mockResolvedValue(null);

      const refusal = await ctx.service.compensationIntent('org_1', 'p1').catch((e) => e);

      expect(refusal).toMatchObject({
        errorCode: ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_UNPROVEN,
        statusCode: 409,
      });
      expect(refusal.message).toContain('no proved stake authority');
      expect(refusal.message).not.toContain('never executed');
      expect(ctx.stakeIntents.buildIntent).not.toHaveBeenCalled();
    });

    it('refuses to compensate a case that never executed', async () => {
      const ctx = build();
      ctx.proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.UPHELD,
      });

      await expect(
        ctx.service.markCompensated(
          OPERATOR as never,
          APPROVER as never,
          'org_1',
          'p1',
          'deposit-signature-1',
          'MAPPING_REGRESSION',
          'nothing to undo',
        ),
      ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_NOT_EXECUTED });
      expect(ctx.stakeIntents.confirmedDeposit).not.toHaveBeenCalled();
    });
  });
});

// ── The two sweeps' repository queries, on the fake ──────────────────────────
//
// These pin the *contract* the propose and execute/reconcile sweeps depend on.
// The fake's array filters are meant to be checkable, predicate by predicate,
// against `SlashProposalRepository`'s SQL.

const NOW = new Date('2026-08-20T00:00:00Z');
const TEN_MINUTES_AGO = new Date('2026-08-19T23:50:00Z');

function hoursFromNow(hours: number): Date {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000);
}

/** A row for the fake, seeded with an id and whatever the case cares about. */
function row(overrides: Partial<Parameters<FakeSlashProposals['seed']>[0]> & { id: string }) {
  return { organizationId: 'org_1', ...overrides };
}

describe("the propose sweep's selection contract", () => {
  it('never proposes for a case the provider has not been told about', async () => {
    // respond_by_at is null until a channel confirms delivery. Proposing then
    // would reserve a provider's stake for a case they cannot answer, and the
    // delivery-confirmed deadline exists precisely so a dead webhook does not cost them their window.
    const proposals = new FakeSlashProposals();
    proposals.seed(
      row({ id: 'undelivered', status: 'PROPOSED', respondByAt: null, chainStatus: 'NONE' }),
    );
    proposals.seed(
      row({
        id: 'delivered',
        status: 'PROPOSED',
        respondByAt: hoursFromNow(48),
        chainStatus: 'NONE',
      }),
    );

    const picked = await proposals.findAwaitingChainProposal(NOW, TEN_MINUTES_AGO, 100);

    expect(picked.map((r) => r.id)).toEqual(['delivered']);
  });

  it('never proposes for a case that is already terminal', async () => {
    const proposals = new FakeSlashProposals();
    proposals.seed(
      row({
        id: 'overturned',
        status: 'OVERTURNED',
        respondByAt: hoursFromNow(-1),
        chainStatus: 'NONE',
      }),
    );
    proposals.seed(
      row({ id: 'waived', status: 'WAIVED', respondByAt: hoursFromNow(-1), chainStatus: 'NONE' }),
    );
    proposals.seed(
      row({ id: 'upheld', status: 'UPHELD', respondByAt: hoursFromNow(-1), chainStatus: 'NONE' }),
    );

    const picked = await proposals.findAwaitingChainProposal(NOW, TEN_MINUTES_AGO, 100);

    expect(picked.map((r) => r.id)).toEqual(['upheld']);
  });

  it('reaps a PROPOSING claim older than the stale window', async () => {
    // Crash point 1 and 2: the claim landed, the transaction may or may not
    // have. Retrying is safe because the chain's `init` refuses a second one.
    const proposals = new FakeSlashProposals();
    proposals.seed(
      row({
        id: 'fresh',
        status: 'PROPOSED',
        respondByAt: hoursFromNow(48),
        chainStatus: 'PROPOSING',
        chainClaimedAt: NOW,
      }),
    );
    proposals.seed(
      row({
        id: 'stale',
        status: 'PROPOSED',
        respondByAt: hoursFromNow(48),
        chainStatus: 'PROPOSING',
        chainClaimedAt: new Date(0),
      }),
    );

    const picked = await proposals.findAwaitingChainProposal(NOW, TEN_MINUTES_AGO, 100);

    expect(picked.map((r) => r.id)).toEqual(['stale']);
  });

  it('respects the limit and orders oldest-proposed first', async () => {
    const proposals = new FakeSlashProposals();
    proposals.seed(
      row({
        id: 'newer',
        status: 'PROPOSED',
        respondByAt: hoursFromNow(48),
        chainStatus: 'NONE',
        proposedAt: new Date('2026-08-11T00:00:00Z'),
      }),
    );
    proposals.seed(
      row({
        id: 'older',
        status: 'PROPOSED',
        respondByAt: hoursFromNow(48),
        chainStatus: 'NONE',
        proposedAt: new Date('2026-08-10T00:00:00Z'),
      }),
    );

    const picked = await proposals.findAwaitingChainProposal(NOW, TEN_MINUTES_AGO, 1);

    expect(picked.map((r) => r.id)).toEqual(['older']);
  });
});

describe("the execute sweep's selection contract", () => {
  it('only executes what both the case and the chain agree is payable', async () => {
    const proposals = new FakeSlashProposals();
    proposals.seed(
      row({
        id: 'not-upheld',
        status: 'DISPUTED',
        chainStatus: 'PENDING',
        chainExecutableAt: hoursFromNow(-1),
        earliestExecutionAt: hoursFromNow(-1),
      }),
    );
    proposals.seed(
      row({
        id: 'chain-not-pending',
        status: 'UPHELD',
        chainStatus: 'PROPOSING',
        chainExecutableAt: hoursFromNow(-1),
        earliestExecutionAt: hoursFromNow(-1),
      }),
    );
    proposals.seed(
      row({
        id: 'chain-not-due',
        status: 'UPHELD',
        chainStatus: 'PENDING',
        chainExecutableAt: hoursFromNow(1),
        earliestExecutionAt: hoursFromNow(-1),
      }),
    );
    proposals.seed(
      row({
        id: 'promise-not-due',
        status: 'UPHELD',
        chainStatus: 'PENDING',
        chainExecutableAt: hoursFromNow(-1),
        earliestExecutionAt: hoursFromNow(1),
      }),
    );
    proposals.seed(
      row({
        id: 'due',
        status: 'UPHELD',
        chainStatus: 'PENDING',
        chainExecutableAt: hoursFromNow(-1),
        earliestExecutionAt: hoursFromNow(-1),
      }),
    );

    const picked = await proposals.findChainExecutable(NOW, 100);

    expect(picked.map((r) => r.id)).toEqual(['due']);
  });
});

describe('reconciling a crashed EXECUTING claim', () => {
  it('finds an EXECUTING row whose claim is older than the stale window, and not a fresh one', async () => {
    const proposals = new FakeSlashProposals();
    proposals.seed(row({ id: 'fresh', status: 'EXECUTING', chainClaimedAt: NOW }));
    proposals.seed(row({ id: 'stale', status: 'EXECUTING', chainClaimedAt: new Date(0) }));
    proposals.seed(row({ id: 'not-executing', status: 'UPHELD', chainClaimedAt: new Date(0) }));

    const picked = await proposals.findExecutingToReconcile(TEN_MINUTES_AGO, 100);

    expect(picked.map((r) => r.id)).toEqual(['stale']);
  });

  it('also finds the adopted-EXECUTED park, which no other sweep can reach', async () => {
    // `proposeDue` parks a row whose request id already carried an EXECUTED
    // record: it mirrors `chain_status = 'EXECUTED'` and leaves the case
    // status alone, which drops the row out of `findAwaitingChainProposal`
    // (`chain_status` is no longer NONE/PROPOSING) and out of
    // `findChainExecutable` (it was never PENDING). `chain_status = 'EXECUTED'
    // AND executed_at IS NULL` is a pair no other path produces, so it is
    // exactly the predicate that reaches it — and only this sweep has anything
    // to do about it, because the money has already moved.
    const proposals = new FakeSlashProposals();
    proposals.seed(
      row({
        id: 'parked',
        status: 'PROPOSED',
        chainStatus: 'EXECUTED',
        chainClaimedAt: new Date(0),
      }),
    );
    proposals.seed(
      row({
        id: 'recorded',
        status: 'EXECUTED',
        chainStatus: 'EXECUTED',
        chainClaimedAt: new Date(0),
        executedAt: new Date('2026-08-19T00:00:00Z'),
        appliedAmount: '900',
      }),
    );
    proposals.seed(
      row({ id: 'fresh-park', status: 'PROPOSED', chainStatus: 'EXECUTED', chainClaimedAt: NOW }),
    );

    const picked = await proposals.findExecutingToReconcile(TEN_MINUTES_AGO, 100);

    expect(picked.map((r) => r.id)).toEqual(['parked']);
  });
});

describe('claimChainStatus (the chain-mirror CAS)', () => {
  it('claims only from an expected chain_status, and reports zero when the row moved first', async () => {
    const proposals = new FakeSlashProposals();
    proposals.seed(row({ id: 'p1', status: 'PROPOSED', chainStatus: 'NONE' }));

    const won = await proposals.claimChainStatus('org_1', 'p1', ['NONE'], 'PROPOSING', NOW);
    expect(won).toBe(1);
    expect(proposals.rows.get('p1')!.chainStatus).toBe('PROPOSING');
    expect(proposals.rows.get('p1')!.chainClaimedAt).toEqual(NOW);

    // Somebody else's claim already moved it — this one loses.
    const lost = await proposals.claimChainStatus('org_1', 'p1', ['NONE'], 'PROPOSING', NOW);
    expect(lost).toBe(0);
  });

  it('refuses to re-claim a row already at the target whose claim is still fresh', async () => {
    // The propose sweep has to accept `PROPOSING` in `expectedFrom` (D4 crash
    // point 1), which is exactly what makes a bare `chain_status IN (…)`
    // non-exclusive: both workers find `PROPOSING` and both are told they won.
    const proposals = new FakeSlashProposals();
    proposals.seed(
      row({ id: 'p1', status: 'PROPOSED', chainStatus: 'PROPOSING', chainClaimedAt: NOW }),
    );

    const lost = await proposals.claimChainStatus(
      'org_1',
      'p1',
      ['NONE', 'PROPOSING'],
      'PROPOSING',
      NOW,
      { staleClaimBefore: TEN_MINUTES_AGO },
    );

    expect(lost).toBe(0);
    expect(proposals.rows.get('p1')!.chainClaimedAt).toEqual(NOW);
  });

  it('re-claims a row already at the target once its claim has gone stale', async () => {
    const proposals = new FakeSlashProposals();
    proposals.seed(
      row({ id: 'p1', status: 'PROPOSED', chainStatus: 'PROPOSING', chainClaimedAt: new Date(0) }),
    );

    const won = await proposals.claimChainStatus(
      'org_1',
      'p1',
      ['NONE', 'PROPOSING'],
      'PROPOSING',
      NOW,
      { staleClaimBefore: TEN_MINUTES_AGO },
    );

    expect(won).toBe(1);
    expect(proposals.rows.get('p1')!.chainClaimedAt).toEqual(NOW);
  });

  it('claims a NONE row unconditionally, however recently it was touched', async () => {
    // The stale guard binds only a row already at the target. A `NONE` row is
    // nobody's work in flight, so no claim of its own has to expire first.
    const proposals = new FakeSlashProposals();
    proposals.seed(row({ id: 'p1', status: 'PROPOSED', chainStatus: 'NONE', chainClaimedAt: NOW }));

    const won = await proposals.claimChainStatus(
      'org_1',
      'p1',
      ['NONE', 'PROPOSING'],
      'PROPOSING',
      NOW,
      { staleClaimBefore: TEN_MINUTES_AGO },
    );

    expect(won).toBe(1);
  });

  it('refuses the claim when the case status left the allowed set', async () => {
    const proposals = new FakeSlashProposals();
    proposals.seed(row({ id: 'p1', status: 'OVERTURNED', chainStatus: 'NONE' }));

    const lost = await proposals.claimChainStatus(
      'org_1',
      'p1',
      ['NONE', 'PROPOSING'],
      'PROPOSING',
      NOW,
      { caseStatusIn: ['PROPOSED', 'DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND', 'UPHELD'] },
    );

    expect(lost).toBe(0);
    expect(proposals.rows.get('p1')!.chainStatus).toBe('NONE');
  });
});

describe('update()', () => {
  it('writes a partial patch onto the row scoped by organizationId and id', async () => {
    const proposals = new FakeSlashProposals();
    proposals.seed(row({ id: 'p1', status: 'UPHELD', executionSignature: null }));

    const result = await proposals.update(
      { organizationId: 'org_1', id: 'p1' },
      { status: 'EXECUTED', executionSignature: 'sig_1' },
    );

    expect(result.affected).toBe(1);
    expect(proposals.rows.get('p1')!.status).toBe('EXECUTED');
    expect(proposals.rows.get('p1')!.executionSignature).toBe('sig_1');
  });

  it('affects nothing for the wrong organization', async () => {
    const proposals = new FakeSlashProposals();
    proposals.seed(row({ id: 'p1', status: 'UPHELD' }));

    const result = await proposals.update(
      { organizationId: 'org_other', id: 'p1' },
      { status: 'EXECUTED' },
    );

    expect(result.affected).toBe(0);
    expect(proposals.rows.get('p1')!.status).toBe('UPHELD');
  });
});

// ── `proposeDue()` — put the judgement on chain and start the clock ──

/**
 * The vault owner, in both spellings. The column is CAIP-10 and the port takes
 * the bare base58 address, and this boundary is the only place the two meet.
 */
const BENEFICIARY = 'Vau1t1111111111111111111111111111111111111';
const BENEFICIARY_CAIP = `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${BENEFICIARY}`;

/** The chain's replay lock for a row, derived the way the row's column was. */
function requestIdOf(id: string): string {
  return deriveChainRequestId({ id, chainEpoch: 0 });
}

/** A row `findAwaitingChainProposal` will pick up: told, live, nothing on chain. */
function proposable(
  overrides: Partial<Parameters<FakeSlashProposals['seed']>[0]> & { id: string },
) {
  return row({
    status: 'PROPOSED',
    respondByAt: hoursFromNow(48),
    chainStatus: 'NONE',
    // Distinct per row, and derived rather than typed, so a case that
    // discriminates on the request id is discriminating on the real one.
    chainRequestId: requestIdOf(overrides.id),
    ...overrides,
  });
}

/**
 * The refusal the executor actually throws, built by its actual factory —
 * `chainErrorName` reads `context.customErrorCode`, which only exists because
 * `AppError` retains the factory's context bag. A hand-shaped object would
 * test the fake.
 */
/**
 * The program's code for a variant, looked up by NAME. `refactor/trim-optional-doors`
 * removed eight variants from the middle of the enum and renumbered everything
 * after 6035 — `SlashNotPending` went from 6042 to 6040 — and every literal
 * below silently started meaning a different refusal. The classifier keys on
 * names; so does this file now.
 */
function codeOf(name: string): number {
  const index = SETTLEMENT_ERROR_NAMES.indexOf(name);
  if (index < 0) {
    throw new Error(`no settlement error named ${name}`);
  }
  return SETTLEMENT_ERROR_CODE_BASE + index;
}

function refusal(customErrorCode: number, reason: string) {
  return ChainErrors.transactionFailed({
    instruction: 'propose_slash',
    signature: null,
    customErrorCode,
    reason,
  });
}

describe('proposeDue', () => {
  it("reserves the stake and adopts the chain's own clocks", async () => {
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    const promised = proposals.rows.get('p1')!.earliestExecutionAt;
    executor.proposeImpl = async () => ({
      signature: 'sig-propose',
      status: 'PENDING',
      proposedAt: new Date('2026-09-01T00:00:00.000Z'),
      executableAt: new Date('2026-09-04T00:00:00.000Z'),
      reservedMinor: '900',
      adopted: false,
    });

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 1, refused: 0, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('PENDING');
    // The chain's numbers, not this process's. The 72h is measured by the
    // cluster, and a local clock that drifted would execute early or late.
    expect(saved.chainProposedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(saved.chainExecutableAt).toEqual(new Date('2026-09-04T00:00:00.000Z'));
    expect(saved.chainReserved).toBe('900');
    expect(saved.chainProposalSignature).toBe('sig-propose');
    expect(saved.chainLastError).toBeNull();
    // The promise on the screen is untouched.
    expect(saved.earliestExecutionAt).toEqual(promised);
    expect(saved.status).toBe(SlashProposalStatus.PROPOSED);
  });

  it('signs for the stake authority and the tool, never for the org id', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'p1', penaltyAmount: '1234', toolId: 'tool_9' }));

    await service.proposeDue(NOW);

    expect(executor.proposed).toEqual([
      {
        // The chain off the proposal's own asset — what the multiplexer routes on.
        chainId: CHAIN_IDS.SOLANA_DEVNET,
        requestId: requestIdOf('p1'),
        // The address the provider proved control of, not `providerId`.
        provider: 'StakeAuth9999',
        beneficiary: 'agent_1',
        penaltyMinor: '1234',
        policy: 'tool_9',
        responseClass: 'dataFail',
      },
    ]);
  });

  it('stamps the beneficiary before it signs, so the row records what was signed', async () => {
    // `beneficiary` is a field of the signed attestation. Resolving it after
    // the signature would leave the row unable to say who the judgement named.
    const beneficiaries = { resolve: jest.fn().mockResolvedValue(BENEFICIARY_CAIP) };
    const { service, proposals, executor } = build({ beneficiaries });
    proposals.seed(proposable({ id: 'p1', beneficiaryAccount: null }));

    await service.proposeDue(NOW);

    expect(proposals.rows.get('p1')!.beneficiaryAccount).toBe(BENEFICIARY_CAIP);
    expect(executor.proposed[0].beneficiary).toBe(BENEFICIARY);
  });

  it('refuses to sign for a case with no beneficiary, and does not close it', async () => {
    // No resolver wired, so nothing can name who the 60% is owed to. That is a
    // transient composition problem, not a dead judgement: leaving the case
    // alone is what lets a scheduler with the resolver pick it up.
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'p1', beneficiaryAccount: null }));

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 0, refused: 0, failed: 1 });
    expect(executor.proposed).toHaveLength(0);
    expect(proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.PROPOSED);
    expect(proposals.rows.get('p1')!.chainStatus).toBe('PROPOSING');
  });

  it('adopts an existing record rather than reporting a failure', async () => {
    // Crash points 2 and 3: the transaction landed but the row never learned.
    const { service, proposals, events, executor } = build();
    proposals.seed(proposable({ id: 'p1', chainStatus: 'PROPOSING', chainClaimedAt: new Date(0) }));
    executor.proposeImpl = async () => ({
      signature: '',
      status: 'PENDING',
      proposedAt: new Date('2026-09-01T00:00:00.000Z'),
      executableAt: new Date('2026-09-04T00:00:00.000Z'),
      reservedMinor: '900',
      adopted: true,
    });

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 1, refused: 0, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('PENDING');
    // Never an empty string: inventing a signature would put a transaction in
    // the case timeline that nobody can look up.
    expect(saved.chainProposalSignature).toBeNull();
    expect(events.kinds()).toContain('CHAIN_PROPOSAL_ADOPTED');
  });

  it('closes the case when the chain refuses permanently, and does not retry', async () => {
    // Crash point 4. PenaltyExceedsMaximum means the judgement was larger than
    // the provider's contract allows — no amount of retrying changes that, and
    // leaving it PROPOSING would retry it every ten minutes forever.
    const { service, proposals, notifications, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    executor.proposeImpl = async () => {
      throw refusal(
        codeOf('PenaltyExceedsMaximum'),
        'the penalty is above this provider’s contract',
      );
    };

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 0, refused: 1, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('REFUSED');
    expect(saved.chainLastError).toBe('PenaltyExceedsMaximum');
    expect(saved.status).toBe(SlashProposalStatus.CANCELLED);
    expect(saved.resolutionKind).toBe(ResolutionKind.AUTO_CHAIN_VOIDED);
    // `chk_slash_proposals_resolution_is_whole`: the two move together or the
    // database refuses the row.
    expect(saved.resolvedAt).not.toBeNull();
    // A revoked key or a contract ceiling says nothing about whether the
    // provider failed, so it is not our error rate that moves.
    expect(saved.countsAsFalsePositive).toBe(false);
    // And no adjudicated outcome is invented for a case no human read.
    expect(saved.outcome).toBeNull();
    expect(notifications.sent.map((n) => n.event)).toContain('provider.slash_decided');
  });

  it("leaves an adjudicator's outcome standing when the chain voids the case", async () => {
    // `chk_slash_proposals_outcome_needs_adjudicator` admits `AUTO_CHAIN_VOIDED`
    // beside `UPHELD` and `UPHELD_RECALCULATED` and beside nothing else. The
    // human's judgement stands; only the *closure* was automatic. Overwriting
    // the outcome would erase a decision somebody made and signed.
    const { service, proposals, executor } = build();
    proposals.seed(
      proposable({
        id: 'p1',
        status: 'UPHELD',
        outcome: ArbitrationOutcome.UPHELD,
        resolutionKind: ResolutionKind.ADJUDICATOR,
        resolvedAt: new Date('2026-08-19T00:00:00Z'),
        decidedByOperatorId: 'op_1',
      }),
    );
    executor.proposeImpl = async () => {
      throw refusal(codeOf('VerifierRevoked'), 'this verifier key has been revoked');
    };

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 0, refused: 1, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.CANCELLED);
    expect(saved.outcome).toBe(ArbitrationOutcome.UPHELD);
    expect(saved.resolutionKind).toBe(ResolutionKind.AUTO_CHAIN_VOIDED);
    expect(saved.resolvedAt).not.toBeNull();
    expect(saved.chainLastError).toBe('VerifierRevoked');
  });

  it('leaves a transient failure claimed so the stale sweep retries it', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    executor.proposeImpl = async () => {
      throw new Error('fetch failed');
    };

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 0, refused: 0, failed: 1 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('PROPOSING');
    expect(saved.status).toBe(SlashProposalStatus.PROPOSED);
    expect(saved.chainLastError).toBe('transport');
    // The claim is what the stale sweep reaps ten minutes later.
    expect(saved.chainClaimedAt).toEqual(NOW);
  });

  it('retries a WAIT refusal rather than closing the case', async () => {
    // `SlashCapExceeded` is a function of a rolling 24h window that drains
    // continuously. Closing on it would discharge a penalty still owed.
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    executor.proposeImpl = async () => {
      throw refusal(codeOf('SlashCapExceeded'), 'the daily cap is spent');
    };

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 0, refused: 0, failed: 1 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('PROPOSING');
    expect(saved.chainLastError).toBe('SlashCapExceeded');
    expect(saved.status).toBe(SlashProposalStatus.PROPOSED);
  });

  it('closes the case when an adopted record has already been cancelled or expired', async () => {
    // The request id is spent: `init` admits one record per id and neither
    // `cancel_slash` nor `expire_slash` closes the account, so this one sits at
    // the PDA forever. Scheduling an execution against it buys a failure in 72
    // hours instead of now.
    const { service, proposals, notifications, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    executor.proposeImpl = async () => ({
      signature: '',
      status: 'CANCELLED',
      proposedAt: new Date('2026-09-01T00:00:00.000Z'),
      executableAt: new Date('2026-09-04T00:00:00.000Z'),
      reservedMinor: '0',
      adopted: true,
    });

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 0, refused: 1, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('CANCELLED');
    expect(saved.status).toBe(SlashProposalStatus.CANCELLED);
    expect(saved.resolutionKind).toBe(ResolutionKind.AUTO_CHAIN_VOIDED);
    expect(saved.resolvedAt).not.toBeNull();
    expect(notifications.sent.map((n) => n.event)).toContain('provider.slash_decided');
  });

  it('parks an adopted record the chain already executed instead of cancelling it', async () => {
    // The money moved. Telling the provider their penalty was cancelled would
    // be false, and re-proposing is impossible, so the row records what the
    // chain says and stops — out of both sweeps' predicates, and loud.
    const { service, proposals, notifications, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    executor.proposeImpl = async () => ({
      signature: '',
      status: 'EXECUTED',
      proposedAt: new Date('2026-09-01T00:00:00.000Z'),
      executableAt: new Date('2026-09-04T00:00:00.000Z'),
      reservedMinor: '900',
      adopted: true,
    });

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 0, refused: 1, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('EXECUTED');
    // `chk_slash_proposals_chain_pending_is_whole` wants both clocks for
    // EXECUTED as much as for PENDING.
    expect(saved.chainProposedAt).not.toBeNull();
    expect(saved.chainExecutableAt).not.toBeNull();
    // The case is NOT cancelled and the provider is NOT told it was.
    expect(saved.status).toBe(SlashProposalStatus.PROPOSED);
    expect(saved.resolutionKind).toBeNull();
    expect(notifications.sent).toHaveLength(0);

    // The parked row's exact column state, pinned because the reconcile
    // sweep selects on it: `chain_status = 'EXECUTED' AND executed_at IS NULL`
    // is a pair no other path in this service can produce. `chain_claimed_at`
    // is left standing at the claim, so a claim-age predicate finds it too.
    expect(saved.executedAt).toBeNull();
    expect(saved.appliedAmount).toBeNull();
    expect(saved.executionSignature).toBeNull();
    expect(saved.chainProposalSignature).toBeNull();
    expect(saved.chainLastError).toBeNull();
    expect(saved.chainReserved).toBe('900');
    expect(saved.chainClaimedAt).toEqual(NOW);
  });

  it('does not stop the pass when one provider fails', async () => {
    // One provider's RPC problem must not hold another provider's harmed agent
    // out of their compensation — the same rule executeDue already keeps.
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'bad', proposedAt: new Date('2026-08-10T00:00:00Z') }));
    proposals.seed(proposable({ id: 'good', proposedAt: new Date('2026-08-11T00:00:00Z') }));
    executor.proposeImpl = async (request) => {
      if (request.requestId === requestIdOf('bad')) throw new Error('fetch failed');
      return {
        signature: 's',
        status: 'PENDING',
        proposedAt: NOW,
        executableAt: hoursFromNow(72),
        reservedMinor: '1',
        adopted: false,
      };
    };

    expect(await service.proposeDue(NOW)).toEqual({ proposed: 1, refused: 0, failed: 1 });
    expect(proposals.rows.get('good')!.chainStatus).toBe('PENDING');
    expect(proposals.rows.get('bad')!.chainStatus).toBe('PROPOSING');
  });

  it('skips a row another worker claimed first', async () => {
    // `claimChainStatus` is the CAS. Losing it is not an error and must not be
    // counted as one — the winner is already proposing for that row.
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    jest.spyOn(proposals, 'claimChainStatus').mockResolvedValue(0);

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 0, refused: 0, failed: 0 });
    expect(executor.proposed).toHaveLength(0);
  });

  it('refuses to run without an executor rather than reporting an empty pass', async () => {
    const service = new SlashExecutionService(
      new FakeSlashProposals() as never,
      { findOne: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      new FakeNotifications() as never,
      TEST_SLASH_CONFIG,
      null,
    );

    await expect(service.proposeDue(NOW)).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_NOT_EXECUTED,
    });
  });
});

// ── The claim is exclusive in both columns ──────────────────────────────────
//
// Both of these exercise the real window: the sweep's SELECT chose a batch,
// and the world moved while an earlier row in that batch was doing seconds to
// minutes of chain work. The interleaving is driven from `proposeImpl`, which
// runs at exactly the point a real `propose()` would be awaiting confirmation.

/**
 * The other end of `extendDeadline`'s guard, and the larger half of the same
 * defect.
 *
 * `extendDeadline` refuses an extension that outruns a door that already
 * exists. A case still on `chain_status = 'NONE'` has no door to compare
 * against, so the extension is granted — and `ExtendDeadlineBodyDto` allows up
 * to 14 days. Proposing that case blindly would freeze a door at
 * `proposed_at + slash_delay_seconds` days before the promise the provider was
 * given, and `execute_slash` is permissionless, so the gap belongs to whoever
 * finds it first.
 *
 * `MIN_SLASH_DELAY_MS` is the program's floor on `slash_delay_seconds`, so
 * `now + 72h` is the earliest a record written on this tick could be spent. The
 * bound needs no RPC, and it is one-sided in the safe direction: it can only
 * make the sweep wait longer than strictly necessary, never propose earlier
 * than it should.
 */
describe('proposeDue — a promise the chain could not keep', () => {
  it('does not propose a case whose promise outruns the earliest possible door', async () => {
    const { service, proposals, executor } = build();
    // Extended by 14 days, the DTO's maximum, while nothing stood on chain.
    proposals.seed(proposable({ id: 'p1', earliestExecutionAt: hoursFromNow(14 * 24) }));

    const result = await service.proposeDue(NOW);

    // A deferral, not a refusal: nothing sent, nothing counted.
    expect(result).toEqual({ proposed: 0, refused: 0, failed: 0 });
    expect(executor.proposed).toEqual([]);

    const saved = proposals.rows.get('p1')!;
    // And not even claimed — the row is exactly what the sweep selects, so it
    // proposes itself on the first tick that can honour the promise.
    expect(saved.chainStatus).toBe('NONE');
    expect(saved.chainClaimedAt).toBeNull();
    expect(saved.chainExecutableAt).toBeNull();
  });

  it('proposes the same case once the promise is inside the floor', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'p1', earliestExecutionAt: hoursFromNow(71) }));

    expect(await service.proposeDue(NOW)).toEqual({ proposed: 1, refused: 0, failed: 0 });
    expect(executor.proposed).toHaveLength(1);
    expect(proposals.rows.get('p1')!.chainStatus).toBe('PENDING');
  });

  /**
   * The comparison is `>` and not `>=`. A promise landing exactly on the floor
   * is one the chain provably honours, and refusing it would defer a case for a
   * millisecond of arithmetic.
   */
  it('proposes a promise that lands exactly on the floor', async () => {
    const { service, proposals } = build();
    proposals.seed(proposable({ id: 'p1', earliestExecutionAt: hoursFromNow(72) }));

    expect(await service.proposeDue(NOW)).toEqual({ proposed: 1, refused: 0, failed: 0 });
  });

  it('holds one case back without holding up the batch', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'deferred', earliestExecutionAt: hoursFromNow(14 * 24) }));
    proposals.seed(proposable({ id: 'ordinary' }));

    expect(await service.proposeDue(NOW)).toEqual({ proposed: 1, refused: 0, failed: 0 });
    expect(executor.proposed.map((p) => p.requestId)).toEqual([requestIdOf('ordinary')]);
  });

  /**
   * The one case the forward-looking bound provably cannot cover. `propose()`
   * may ADOPT a record somebody else wrote, whose `proposed_at` is in the past,
   * so its door can be older than anything derivable from `now` — including a
   * door that has already opened.
   *
   * Nothing is undone: the mirror is the truth about what is on chain and must
   * stand, `findChainExecutable` waits on `max(both clocks)` so this process
   * still will not execute early, and the stranger is beyond any code here. A
   * loud line and a human is the whole of the available remedy.
   */
  it('says so loudly when an adopted record opens before the promise', async () => {
    const { service, proposals, executor } = build();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    proposals.seed(proposable({ id: 'p1', earliestExecutionAt: hoursFromNow(60) }));
    executor.proposeImpl = async () => ({
      signature: '',
      status: 'PENDING',
      // Adopted: written four days ago, so its door opened an hour ago.
      proposedAt: hoursFromNow(-73),
      executableAt: hoursFromNow(-1),
      reservedMinor: '900',
      adopted: true,
    });

    try {
      expect(await service.proposeDue(NOW)).toEqual({ proposed: 1, refused: 0, failed: 0 });

      // The mirror stands. Hiding a record that exists is worse than a bad one.
      const saved = proposals.rows.get('p1')!;
      expect(saved.chainStatus).toBe('PENDING');
      expect(saved.chainExecutableAt).toEqual(hoursFromNow(-1));
      // The promise is untouched — the row still says what the provider was told.
      expect(saved.earliestExecutionAt).toEqual(hoursFromNow(60));

      // And a human is told, with both moments in the line.
      const said = error.mock.calls.map((call) => String(call[0])).join('\n');
      expect(said).toContain(hoursFromNow(-1).toISOString());
      expect(said).toContain(hoursFromNow(60).toISOString());
      expect(said).toContain('permissionless');
    } finally {
      error.mockRestore();
    }
  });

  /**
   * The re-propose path runs the same rule, on its second half. By then the
   * admin's cancel has landed and the sweep has mirrored `CANCELLED`, so the
   * row is reset to `NONE` with both clocks nulled — exactly what the sweep
   * selects — and returning early strands nothing and reserves nothing.
   */
  it('defers the re-propose rather than freezing a door before the promise', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(
      standing({
        id: 'p1',
        status: 'UPHELD',
        chainEpoch: 0,
        penaltyAmount: '400000',
        chainReserved: '5000000',
        chainStatus: 'CANCELLED',
        earliestExecutionAt: hoursFromNow(14 * 24),
      }),
    );

    await service.reproposeAtRevisedPenalty('org_1', 'p1', NOW);

    const saved = proposals.rows.get('p1')!;
    // Bumped, so nothing is reserved at the old figure...
    expect(saved.chainEpoch).toBe(1);
    // ...and left in the state the sweep re-proposes from, unproposed.
    expect(saved.chainStatus).toBe('NONE');
    expect(saved.chainExecutableAt).toBeNull();
    expect(executor.proposed).toEqual([]);
  });
});

describe('proposeDue — the gap between the SELECT and the claim', () => {
  it('does not sign for a case another worker claimed while this pass was busy', async () => {
    // Without the staleness guard both workers see `PROPOSING` in the accepted
    // set, both are told they won, and two attestations for one request id land
    // in the verifier signing journal. Only the program's `init` lock would
    // stop the second penalty — a backstop, not a design.
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'first', proposedAt: new Date('2026-08-10T00:00:00Z') }));
    proposals.seed(proposable({ id: 'second', proposedAt: new Date('2026-08-11T00:00:00Z') }));

    executor.proposeImpl = async (request) => {
      if (request.requestId === requestIdOf('first')) {
        // The other replica claims `second` while this one is confirming.
        Object.assign(proposals.rows.get('second')!, {
          chainStatus: 'PROPOSING',
          chainClaimedAt: NOW,
        });
      }
      return {
        signature: 'sig',
        status: 'PENDING' as const,
        proposedAt: NOW,
        executableAt: hoursFromNow(72),
        reservedMinor: '900',
        adopted: false,
      };
    };

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 1, refused: 0, failed: 0 });
    expect(executor.proposed.map((r) => r.requestId)).toEqual([requestIdOf('first')]);
    // Untouched: the other worker's claim still stands, with its own timestamp.
    expect(proposals.rows.get('second')!.chainStatus).toBe('PROPOSING');
  });

  it('does not reserve stake for a case that went terminal since it was selected', async () => {
    // `execute_slash` is permissionless, so a record proposed for an overturned
    // case is a stranger's to execute 72 hours later — and `voidCase` could not
    // clean it up, because `OVERTURNED` is deliberately outside
    // `CHAIN_VOIDABLE_STATUSES`.
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'first', proposedAt: new Date('2026-08-10T00:00:00Z') }));
    proposals.seed(proposable({ id: 'second', proposedAt: new Date('2026-08-11T00:00:00Z') }));

    executor.proposeImpl = async (request) => {
      if (request.requestId === requestIdOf('first')) {
        // An adjudicator overturns `second` while this pass is confirming.
        Object.assign(proposals.rows.get('second')!, {
          status: SlashProposalStatus.OVERTURNED,
          outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
          resolutionKind: ResolutionKind.ADJUDICATOR,
          resolvedAt: NOW,
          decidedByOperatorId: 'op_1',
        });
      }
      return {
        signature: 'sig',
        status: 'PENDING' as const,
        proposedAt: NOW,
        executableAt: hoursFromNow(72),
        reservedMinor: '900',
        adopted: false,
      };
    };

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 1, refused: 0, failed: 0 });
    expect(executor.proposed.map((r) => r.requestId)).toEqual([requestIdOf('first')]);
    // Nothing was claimed and nothing was signed for the overturned case.
    expect(proposals.rows.get('second')!.chainStatus).toBe('NONE');
    expect(proposals.rows.get('second')!.status).toBe(SlashProposalStatus.OVERTURNED);
  });

  /**
   * The gap the claim cannot close: the case is closed AFTER the claim, while
   * `propose_slash` is in flight. The close finds `PROPOSING` and has nothing to
   * cancel yet; the record then lands, and a mirror written as plain `PENDING`
   * would leave a closed case with its stake reserved and nobody asking for
   * the cancel.
   */
  it.each([SlashProposalStatus.CANCELLED, SlashProposalStatus.OVERTURNED])(
    'asks for the cancel when the case went %s while its proposal was in flight',
    async (closedAs) => {
      const { service, proposals, executor, events } = build();
      proposals.seed(proposable({ id: 'p1' }));
      executor.proposeImpl = async () => {
        proposals.rows.get('p1')!.status = closedAs;
        return {
          signature: 'sig',
          status: 'PENDING' as const,
          proposedAt: NOW,
          executableAt: hoursFromNow(72),
          reservedMinor: '900',
          adopted: false,
        };
      };

      await service.proposeDue(NOW);

      const saved = proposals.rows.get('p1')!;
      expect(saved.status).toBe(closedAs);
      expect(saved.chainStatus).toBe('CANCEL_REQUESTED');
      // The chain's clocks are still on the row: the cancel has a deadline.
      expect(saved.chainExecutableAt).toEqual(hoursFromNow(72));
      expect(events.kinds()).toContain('CHAIN_CANCEL_REQUESTED');
    },
  );

  it('leaves a live case PENDING when its proposal confirms', async () => {
    const { service, proposals, events } = build();
    proposals.seed(proposable({ id: 'p1' }));

    await service.proposeDue(NOW);

    expect(proposals.rows.get('p1')!.chainStatus).toBe('PENDING');
    expect(events.kinds()).not.toContain('CHAIN_CANCEL_REQUESTED');
  });
});

describe('proposeDue — nothing after the chain write may re-classify it', () => {
  it('keeps a mirrored PENDING row when its timeline entry fails', async () => {
    // The chain has spoken and the row records it. Letting the append throw
    // would send the catch-all to stamp `chain_last_error = 'transport'` over a
    // row the chain itself just decided.
    const { service, proposals, events } = build();
    proposals.seed(proposable({ id: 'p1' }));
    jest.spyOn(events, 'append').mockRejectedValue(new Error('events table is down'));

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 1, refused: 0, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('PENDING');
    expect(saved.chainLastError).toBeNull();
  });

  it('completes the cancellation even when its timeline entry and notification both fail', async () => {
    // The failure class Minor 4 was about, on the path the reorder changed.
    // `voidCase`'s transition is the commit point and `CANCELLED` is outside
    // `CHAIN_PROPOSABLE_STATUSES` — which is BOTH the sweep's SELECT predicate
    // and the claim's `caseStatusIn` guard — so an exception escaping after it
    // would have the catch-all stamp `chain_last_error = 'transport'` (an error
    // whose meaning is "will be retried") onto a row nothing can ever reach.
    const { service, proposals, events, notifications, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    executor.proposeImpl = async () => ({
      signature: '',
      status: 'CANCELLED',
      proposedAt: new Date('2026-09-01T00:00:00.000Z'),
      executableAt: new Date('2026-09-04T00:00:00.000Z'),
      reservedMinor: '0',
      adopted: true,
    });
    jest.spyOn(events, 'append').mockRejectedValue(new Error('events table is down'));
    jest.spyOn(notifications, 'notify').mockRejectedValue(new Error('notification port is down'));

    const result = await service.proposeDue(NOW);

    // Counted for what it was — the request id is spent — not as a transport
    // failure.
    expect(result).toEqual({ proposed: 0, refused: 1, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.CANCELLED);
    expect(saved.resolutionKind).toBe(ResolutionKind.AUTO_CHAIN_VOIDED);
    // The mirror still completed, so the row is fully consistent despite both
    // side effects failing.
    expect(saved.chainStatus).toBe('CANCELLED');
    // And above all: no false promise of a retry on a row no sweep can reach.
    expect(saved.chainLastError).toBeNull();
  });

  it('leaves a closed case with a stale mirror, not a false retry, if the mirror write fails', async () => {
    // The honest statement of the residual. `voidCase` has committed
    // `CANCELLED`; the mirror write after it then dies. The row is NOT
    // re-sweepable — `CANCELLED` is outside `CHAIN_PROPOSABLE_STATUSES`, so
    // neither `findAwaitingChainProposal` nor the `caseStatusIn` guard will
    // touch it again — and that is correct rather than merely tolerated: the
    // case is closed, the judgement is Cancelled on chain and immutable, and
    // nothing reads the chain mirror of a closed case.
    //
    // What matters is that it is not marked retryable. The reverse write order
    // would fail worse: the case would stay OPEN behind a `chain_status` no
    // sweep predicate admits, and would never close at all.
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    executor.proposeImpl = async () => ({
      signature: '',
      status: 'CANCELLED',
      proposedAt: new Date('2026-09-01T00:00:00.000Z'),
      executableAt: new Date('2026-09-04T00:00:00.000Z'),
      reservedMinor: '0',
      adopted: true,
    });
    const realUpdate = proposals.update.bind(proposals);
    jest
      .spyOn(proposals, 'update')
      .mockImplementation(async (criteria, patch) =>
        'chainStatus' in patch
          ? Promise.reject(new Error('db went away'))
          : realUpdate(criteria, patch),
      );

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 0, refused: 1, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    // Closed, correctly, and the provider was told.
    expect(saved.status).toBe(SlashProposalStatus.CANCELLED);
    expect(saved.resolutionKind).toBe(ResolutionKind.AUTO_CHAIN_VOIDED);
    // The mirror is stale. Documented, not asserted to be recoverable.
    expect(saved.chainStatus).toBe('PROPOSING');
    // The one thing that would be a lie: an error that means "will be retried"
    // on a row nothing can reach.
    expect(saved.chainLastError).toBeNull();
  });

  it('does not end the pass when a case cannot be voided after a permanent refusal', async () => {
    // The only thing that still escapes `voidCase` is its own transition
    // failing — which means nothing committed, so the case is retryable and
    // must be counted `failed`. It must not take the rest of the batch with it.
    const { service, proposals, executor } = build();
    proposals.seed(proposable({ id: 'first', proposedAt: new Date('2026-08-10T00:00:00Z') }));
    proposals.seed(proposable({ id: 'second', proposedAt: new Date('2026-08-11T00:00:00Z') }));
    executor.proposeImpl = async (request) => {
      if (request.requestId === requestIdOf('first'))
        throw refusal(codeOf('PenaltyExceedsMaximum'), 'above contract');
      return {
        signature: 'sig',
        status: 'PENDING' as const,
        proposedAt: NOW,
        executableAt: hoursFromNow(72),
        reservedMinor: '900',
        adopted: false,
      };
    };
    jest.spyOn(proposals, 'transitionIfIn').mockRejectedValue(new Error('db went away'));

    const result = await service.proposeDue(NOW);

    expect(result).toEqual({ proposed: 1, refused: 0, failed: 1 });
    // Nothing committed for the refused case, so it is still claimable.
    expect(proposals.rows.get('first')!.status).toBe(SlashProposalStatus.PROPOSED);
    // And the other provider's case went through.
    expect(proposals.rows.get('second')!.chainStatus).toBe('PENDING');
  });

  it('stamps the closure and its timeline entry with one clock', async () => {
    const { service, proposals, events, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    executor.proposeImpl = async () => {
      throw refusal(codeOf('PenaltyExceedsMaximum'), 'above contract');
    };

    await service.proposeDue(NOW);

    const saved = proposals.rows.get('p1')!;
    const voided = events.rows.find((entry) => entry.kind === 'CHAIN_VOIDED')!;
    expect(voided.occurredAt).toEqual(saved.resolvedAt);
  });
});

// ── `executeDue()` on `execute_slash`, and `reconcileExecuting()` ────

/** A complete `SlashRecordSnapshot`. No `as never`: the type is the point. */
function chainRecord(overrides: Partial<SlashRecordSnapshot> = {}): SlashRecordSnapshot {
  return {
    status: 'EXECUTED',
    penaltyMinor: '1000',
    appliedMinor: '900',
    agentAmountMinor: '540',
    platformAmountMinor: '270',
    reservedMinor: '900',
    proposedAt: hoursFromNow(-73),
    executableAt: hoursFromNow(-1),
    executedAt: hoursFromNow(-0.5),
    cancelledAt: null,
    ...overrides,
  };
}

/** A row `findChainExecutable` picks up: upheld, on chain, both clocks past. */
function executable(
  overrides: Partial<Parameters<FakeSlashProposals['seed']>[0]> & { id: string },
) {
  return row({
    status: 'UPHELD',
    chainStatus: 'PENDING',
    chainProposedAt: hoursFromNow(-73),
    chainExecutableAt: hoursFromNow(-1),
    earliestExecutionAt: hoursFromNow(-1),
    chainRequestId: requestIdOf(overrides.id),
    // `proposeOne` writes `chain_reserved` in the same statement as
    // `chain_status = 'PENDING'`, so a PENDING row always has one. Defaulted to
    // the row's own penalty — `reserved = min(penalty, cap, free)`, and nothing
    // capped it — so the overtake predicate reads a real number rather than the
    // null that never reaches production.
    chainReserved: overrides.penaltyAmount ?? '5000000',
    ...overrides,
  });
}

/** A row `findExecutingToReconcile` picks up: claimed, and long since orphaned. */
function orphaned(overrides: Partial<Parameters<FakeSlashProposals['seed']>[0]> & { id: string }) {
  return executable({
    status: 'EXECUTING',
    chainClaimedAt: new Date(0),
    ...overrides,
  });
}

/** The refusal `execute_slash` throws, built by the executor's own factory. */
function executeRefusal(customErrorCode: number, reason: string) {
  return ChainErrors.transactionFailed({
    instruction: 'execute_slash',
    signature: null,
    customErrorCode,
    reason,
  });
}

describe('executeDue', () => {
  it('waits for both clocks, not just the promise on the screen', async () => {
    // `earliest_execution_at` is what the provider was told; `chain_executable_at`
    // is what the program enforces, and it is stamped from the chain's own
    // `proposed_at`. A cluster configured with a longer delay must not be
    // executed early by us — `execute_slash` would answer `SlashNotYetExecutable`
    // and the row would have spent a tick, a signature and a claim on it.
    const { service, proposals, executor } = build();
    proposals.seed(
      executable({
        id: 'early',
        earliestExecutionAt: hoursFromNow(-1),
        chainExecutableAt: hoursFromNow(1),
      }),
    );

    expect(await service.executeDue(NOW)).toEqual({ executed: 0, voided: 0, failed: 0 });
    expect(executor.executed).toHaveLength(0);
    expect(proposals.rows.get('early')!.status).toBe(SlashProposalStatus.UPHELD);
  });

  it('waits for the promise too, even once the chain has opened', async () => {
    // The other half of `max(earliest_execution_at, chain_executable_at)`.
    // The slash case screen states the promise in the largest type on the screen and
    // `chk_slash_proposals_execution_respects_timelock` refuses the row, so a
    // service that waited only on the chain would be caught by the database.
    const { service, proposals, executor } = build();
    proposals.seed(
      executable({
        id: 'promised',
        earliestExecutionAt: hoursFromNow(1),
        chainExecutableAt: hoursFromNow(-1),
      }),
    );

    expect(await service.executeDue(NOW)).toEqual({ executed: 0, voided: 0, failed: 0 });
    expect(executor.executed).toHaveLength(0);
  });

  it('writes back what the chain took, not what we asked for', async () => {
    const { service, proposals, events, notifications, executor } = build();
    proposals.seed(executable({ id: 'p1', penaltyAmount: '1000' }));
    // Every number off the chain, and coherent with the row: `applied` is at or
    // under `penalty` (`chk_slash_proposals_applied_within_penalty`) and
    // `executed_at` is at or after both clocks (the two timelock CHECKs).
    executor.executeImpl = async () => ({
      signature: 'sig_1',
      appliedMinor: '900',
      agentAmountMinor: '540',
      platformAmountMinor: '270',
      executedAt: NOW,
    });

    expect(await service.executeDue(NOW)).toEqual({ executed: 1, voided: 0, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.EXECUTED);
    // The cap bit: the judgement asked for 1000 and the chain took 900.
    expect(saved.appliedAmount).toBe('900');
    expect(saved.penaltyAmount).toBe('1000');
    expect(saved.platformAmount).toBe('270');
    expect(saved.chainStatus).toBe('EXECUTED');
    expect(saved.executionSignature).toBe('sig_1');
    expect(saved.executedAt).toEqual(NOW);
    // The claim is released: nothing is in flight for this row any more, and a
    // standing `chain_claimed_at` would keep it in the reconciler's sights.
    expect(saved.chainClaimedAt).toBeNull();
    expect(saved.chainLastError).toBeNull();
    expect(events.kinds()).toContain('EXECUTED');
    expect(notifications.sent.map((n) => n.event)).toContain('provider.slash_executed');
  });

  it('claims the row before it signs, so a crash is findable', async () => {
    // `chain_claimed_at` is what `findExecutingToReconcile` measures staleness
    // against. Moving a case to `EXECUTING` without stamping it would leave the
    // reconciler only its defensive `IS NULL` half to find the row by.
    const { service, proposals, executor } = build();
    proposals.seed(executable({ id: 'p1' }));
    let claimed: { status: string; claimedAt: Date | null } | null = null;
    executor.executeImpl = async () => {
      const live = proposals.rows.get('p1')!;
      claimed = { status: live.status, claimedAt: live.chainClaimedAt };
      throw new Error('fetch failed');
    };

    await service.executeDue(NOW);

    expect(claimed).toEqual({ status: SlashProposalStatus.EXECUTING, claimedAt: NOW });
  });

  it('closes the case when the verifier key was revoked during the wait', async () => {
    // The two-phase slash working as designed, not a fault. `execute_slash` re-asks
    // `assert_can_sign`, so revoking a leaked key voids every judgement it
    // signed that is still in flight — and the backend must record that and
    // stop, not retry it every minute for seven days.
    const { service, proposals, notifications, executor } = build();
    proposals.seed(executable({ id: 'p1' }));
    executor.executeImpl = async () => {
      throw executeRefusal(codeOf('VerifierRevoked'), 'this verifier key has been revoked');
    };

    expect(await service.executeDue(NOW)).toEqual({ executed: 0, voided: 1, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.CANCELLED);
    expect(saved.resolutionKind).toBe(ResolutionKind.AUTO_CHAIN_VOIDED);
    expect(saved.resolvedAt).not.toBeNull();
    expect(saved.chainLastError).toBe('VerifierRevoked');
    // A revoked key says nothing about whether the provider failed.
    expect(saved.countsAsFalsePositive).toBe(false);
    // NOT `REFUSED`. The record is sitting on chain in `Pending` and will be
    // until somebody expires it; `REFUSED` means "no record exists and none
    // will", which would be a lie about a record that plainly does.
    expect(saved.chainStatus).toBe('PENDING');
    expect(notifications.sent.map((n) => n.event)).toContain('provider.slash_decided');
  });

  it('parks a capped judgement at UPHELD so a later tick can pay it', async () => {
    // The per-key daily cap drains continuously and the record is still
    // `Pending` on chain, so the judgement is alive; closing it would discharge
    // a penalty the provider still owes.
    const { service, proposals, executor } = build();
    proposals.seed(executable({ id: 'p1' }));
    executor.executeImpl = async () => {
      throw executeRefusal(
        codeOf('VerifierDailyCapExceeded'),
        'the daily cap for this verifier key is spent',
      );
    };

    expect(await service.executeDue(NOW)).toEqual({ executed: 0, voided: 0, failed: 1 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.UPHELD);
    expect(saved.chainStatus).toBe('PENDING');
    expect(saved.chainLastError).toBe('VerifierDailyCapExceeded');
    // Released, because nothing is in flight: the program processed the
    // transaction and reverted it.
    expect(saved.chainClaimedAt).toBeNull();
  });

  it('leaves the case EXECUTING when the program never spoke', async () => {
    // The distinction this whole path turns on. A NAMED custom error means the
    // transaction was processed and reverted — nothing moved, and the case is
    // safe to re-queue. No name means an RPC failure, an expired blockhash or a
    // confirmation timeout: the transaction may well have LANDED. Returning the
    // case to `UPHELD` there would have the next tick re-submit, get
    // `SlashNotPending`, and close a case whose penalty had in fact been taken.
    const { service, proposals, executor } = build();
    proposals.seed(executable({ id: 'p1' }));
    executor.executeImpl = async () => {
      throw new Error('confirmation timed out');
    };

    expect(await service.executeDue(NOW)).toEqual({ executed: 0, voided: 0, failed: 1 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.EXECUTING);
    // The claim stands, so `findExecutingToReconcile` reaps it in ten minutes
    // and the record — not a guess — decides what happened.
    expect(saved.chainClaimedAt).toEqual(NOW);
    expect(saved.chainLastError).toBe('transport');
  });

  it('does not close a case on SlashNotPending; it reads the record instead', async () => {
    // `SlashNotPending` is in the VOID set because a record that has left
    // `Pending` will never take another `execute_slash`. On THIS path that is
    // not enough to close the case: one of the three ways it can have left is
    // by being EXECUTED — by our own timed-out attempt, or by a stranger, since
    // `execute_slash` is permissionless. Cancelling would tell the provider a
    // penalty was dropped that was in fact taken.
    const { service, proposals, executor, notifications } = build();
    proposals.seed(executable({ id: 'p1' }));
    executor.executeImpl = async () => {
      throw executeRefusal(codeOf('SlashNotPending'), 'the record is no longer pending');
    };

    expect(await service.executeDue(NOW)).toEqual({ executed: 0, voided: 0, failed: 1 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.EXECUTING);
    expect(saved.chainClaimedAt).toEqual(NOW);
    expect(saved.chainLastError).toBe('SlashNotPending');
    expect(notifications.sent).toHaveLength(0);
  });

  it('does not stop the pass when one case fails', async () => {
    // One provider's RPC problem must not hold another provider's harmed agent
    // out of their compensation.
    const { service, proposals, executor } = build();
    proposals.seed(executable({ id: 'bad', chainExecutableAt: hoursFromNow(-2) }));
    proposals.seed(executable({ id: 'good', chainExecutableAt: hoursFromNow(-1) }));
    executor.executeImpl = async (request) => {
      if (request.requestId === requestIdOf('bad')) throw new Error('fetch failed');
      return {
        signature: 'sig-good',
        appliedMinor: '900',
        agentAmountMinor: '540',
        platformAmountMinor: '270',
        executedAt: NOW,
      };
    };

    expect(await service.executeDue(NOW)).toEqual({ executed: 1, voided: 0, failed: 1 });
    expect(proposals.rows.get('good')!.status).toBe(SlashProposalStatus.EXECUTED);
    expect(proposals.rows.get('bad')!.status).toBe(SlashProposalStatus.EXECUTING);
  });

  it('skips a row another worker claimed first', async () => {
    // The `UPHELD → EXECUTING` compare-and-swap is what serialises two
    // schedulers. Losing it is not an error — the winner is already executing —
    // and counting it would make a healthy two-pod deploy look like it was
    // failing half its work.
    const { service, proposals, executor } = build();
    proposals.seed(executable({ id: 'p1' }));
    jest.spyOn(proposals, 'transitionIfIn').mockResolvedValue(0);

    expect(await service.executeDue(NOW)).toEqual({ executed: 0, voided: 0, failed: 0 });
    expect(executor.executed).toHaveLength(0);
  });

  it('refuses to run without an executor rather than reporting an empty pass', async () => {
    const service = new SlashExecutionService(
      new FakeSlashProposals() as never,
      { findOne: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      new FakeNotifications() as never,
      TEST_SLASH_CONFIG,
      null,
    );

    await expect(service.executeDue(NOW)).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_NOT_EXECUTED,
    });
  });
});

describe('executeDue — the seven-day execution grace', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('warns when a parked judgement is running out of grace', async () => {
    // `SLASH_EXECUTION_GRACE_SECONDS` after `executable_at`, anybody may
    // `expire_slash` the record and the judgement can never be executed — the
    // penalty is discharged and the harmed agent is never compensated. The last
    // day of that window is the last chance to find out what keeps capping it.
    const { service, proposals, executor } = build();
    proposals.seed(executable({ id: 'p1', chainExecutableAt: hoursFromNow(-6 * 24 - 12) }));
    executor.executeImpl = async () => {
      throw executeRefusal(codeOf('SlashCapExceeded'), 'the provider cap is spent');
    };

    await service.executeDue(NOW);

    expect(warn.mock.calls.flat().join('\n')).toMatch(/grace/i);
  });

  it('says nothing while there is still grace left', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(executable({ id: 'p1', chainExecutableAt: hoursFromNow(-24) }));
    executor.executeImpl = async () => {
      throw executeRefusal(codeOf('SlashCapExceeded'), 'the provider cap is spent');
    };

    await service.executeDue(NOW);

    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/grace/i);
  });
});

describe('reconcileExecuting', () => {
  it('completes a row whose transaction landed after the process died', async () => {
    const { service, proposals, executor, events, notifications } = build();
    proposals.seed(orphaned({ id: 'p1', penaltyAmount: '1000' }));
    executor.readRecordImpl = async () => chainRecord();

    expect(await service.reconcileExecuting(NOW)).toEqual({
      recovered: 1,
      returned: 0,
      voided: 0,
    });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.EXECUTED);
    expect(saved.appliedAmount).toBe('900');
    expect(saved.platformAmount).toBe('270');
    expect(saved.executedAt).toEqual(hoursFromNow(-0.5));
    expect(saved.chainStatus).toBe('EXECUTED');
    expect(saved.chainClaimedAt).toBeNull();
    // No signature: this process never learned one, and inventing one would put
    // a transaction in the case timeline that nobody can look up.
    expect(saved.executionSignature).toBeNull();
    expect(events.kinds()).toContain('EXECUTED');
    expect(notifications.sent.map((n) => n.event)).toContain('provider.slash_executed');
    // And it read the record rather than re-submitting.
    expect(executor.executed).toHaveLength(0);
    expect(executor.recordReads).toEqual([
      { requestId: requestIdOf('p1'), provider: 'StakeAuth9999' },
    ]);
  });

  it('credits the harmed agents with the request id as the idempotency key', async () => {
    // `SlashCompensationService.distribute` takes it as `signature` and the
    // ledger's unique index is what makes a repeated distribution safe, so what
    // matters is that the value is stable and non-null — which the signature,
    // on this path, is not.
    const compensation = { distribute: jest.fn().mockResolvedValue(1) };
    const { service, proposals, executor } = build({ compensation });
    proposals.seed(orphaned({ id: 'p1' }));
    executor.readRecordImpl = async () => chainRecord();

    await service.reconcileExecuting(NOW);

    expect(compensation.distribute).toHaveBeenCalledWith(
      expect.objectContaining({ signature: requestIdOf('p1'), agentAmountMinor: '540' }),
    );
  });

  it('returns a row to UPHELD when the record is still Pending', async () => {
    // The transaction never landed, or it landed and failed. Either way the
    // judgement is alive and the case belongs back in the execution queue.
    const { service, proposals, executor } = build();
    proposals.seed(orphaned({ id: 'p1' }));
    executor.readRecordImpl = async () => chainRecord({ status: 'PENDING', executedAt: null });

    expect(await service.reconcileExecuting(NOW)).toEqual({
      recovered: 0,
      returned: 1,
      voided: 0,
    });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.UPHELD);
    expect(saved.chainStatus).toBe('PENDING');
    // Released, so the next `executeDue` can claim it again.
    expect(saved.chainClaimedAt).toBeNull();
  });

  it('returns a row to UPHELD when there is no record at the PDA at all', async () => {
    // `readRecord` answers null rather than throwing when the account is
    // absent, and an absent record is an anomaly here: the row only reached
    // `EXECUTING` through `findChainExecutable`, which requires a mirrored
    // `PENDING`, and neither `cancel_slash` nor `expire_slash` closes the
    // account. Returning the case to the queue is the self-correcting answer —
    // the next `executeDue` gets `CHAIN_SLASH_RECORD_NOT_FOUND`, which is
    // terminal and closes the case with the chain's own answer rather than
    // with this sweep's inference.
    const { service, proposals, executor } = build();
    proposals.seed(orphaned({ id: 'p1' }));
    executor.readRecordImpl = async () => null;

    expect(await service.reconcileExecuting(NOW)).toEqual({
      recovered: 0,
      returned: 1,
      voided: 0,
    });
    expect(proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.UPHELD);
  });

  it('voids a row whose record somebody else cancelled or expired', async () => {
    // Neither `cancel_slash` nor `expire_slash` closes the account, so this
    // record reads `Cancelled` forever. The judgement will never be paid.
    const { service, proposals, executor, notifications } = build();
    proposals.seed(orphaned({ id: 'p1' }));
    executor.readRecordImpl = async () =>
      chainRecord({ status: 'CANCELLED', executedAt: null, cancelledAt: hoursFromNow(-0.5) });

    expect(await service.reconcileExecuting(NOW)).toEqual({
      recovered: 0,
      returned: 0,
      voided: 1,
    });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.CANCELLED);
    expect(saved.resolutionKind).toBe(ResolutionKind.AUTO_CHAIN_VOIDED);
    expect(saved.resolvedAt).not.toBeNull();
    // `CANCELLED`, never `REFUSED`: the record exists and says so.
    expect(saved.chainStatus).toBe('CANCELLED');
    expect(saved.countsAsFalsePositive).toBe(false);
    expect(notifications.sent.map((n) => n.event)).toContain('provider.slash_decided');
  });

  it('picks up the adopted-EXECUTED park that no other sweep can reach', async () => {
    // `proposeDue` parks a row whose request id already had an EXECUTED record
    // on chain: it mirrors `chain_status = 'EXECUTED'` and leaves the case
    // alone, which puts the row outside both `findAwaitingChainProposal` and
    // `findChainExecutable`. The money moved and nothing had recorded it.
    const { service, proposals, executor } = build();
    proposals.seed(
      row({
        id: 'parked',
        status: 'PROPOSED',
        penaltyAmount: '1000',
        chainStatus: 'EXECUTED',
        chainProposedAt: hoursFromNow(-73),
        chainExecutableAt: hoursFromNow(-1),
        chainClaimedAt: new Date(0),
        chainRequestId: requestIdOf('parked'),
        executedAt: null,
        earliestExecutionAt: hoursFromNow(-1),
      }),
    );
    executor.readRecordImpl = async () => chainRecord();

    expect(await service.reconcileExecuting(NOW)).toEqual({
      recovered: 1,
      returned: 0,
      voided: 0,
    });
    const saved = proposals.rows.get('parked')!;
    expect(saved.status).toBe(SlashProposalStatus.EXECUTED);
    expect(saved.appliedAmount).toBe('900');
    expect(saved.executedAt).toEqual(hoursFromNow(-0.5));
    expect(saved.executionSignature).toBeNull();
  });

  it('leaves a parked row alone when the chain does not agree it executed', async () => {
    // The mirror said EXECUTED and the record does not. Nothing here may write
    // an execution on that disagreement; it is logged and left for a human.
    const { service, proposals, executor } = build();
    proposals.seed(
      row({
        id: 'parked',
        status: 'PROPOSED',
        chainStatus: 'EXECUTED',
        chainProposedAt: hoursFromNow(-73),
        chainExecutableAt: hoursFromNow(-1),
        chainClaimedAt: new Date(0),
        chainRequestId: requestIdOf('parked'),
        executedAt: null,
      }),
    );
    executor.readRecordImpl = async () => chainRecord({ status: 'PENDING', executedAt: null });

    expect(await service.reconcileExecuting(NOW)).toEqual({
      recovered: 0,
      returned: 0,
      voided: 0,
    });
    const saved = proposals.rows.get('parked')!;
    expect(saved.status).toBe(SlashProposalStatus.PROPOSED);
    expect(saved.executedAt).toBeNull();
  });

  it('does not touch a claim that is still fresh', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(orphaned({ id: 'p1', chainClaimedAt: NOW }));
    executor.readRecordImpl = async () => chainRecord();

    expect(await service.reconcileExecuting(NOW)).toEqual({
      recovered: 0,
      returned: 0,
      voided: 0,
    });
    expect(proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.EXECUTING);
  });

  it('does not stop the pass when one record cannot be read', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(orphaned({ id: 'bad' }));
    proposals.seed(orphaned({ id: 'good', chainClaimedAt: new Date(1) }));
    executor.readRecordImpl = async (requestId) => {
      if (requestId === requestIdOf('bad')) throw new Error('rpc is down');
      return chainRecord();
    };

    expect(await service.reconcileExecuting(NOW)).toEqual({
      recovered: 1,
      returned: 0,
      voided: 0,
    });
    expect(proposals.rows.get('bad')!.status).toBe(SlashProposalStatus.EXECUTING);
    expect(proposals.rows.get('good')!.status).toBe(SlashProposalStatus.EXECUTED);
  });

  it('refuses to run without an executor rather than reporting an empty pass', async () => {
    const service = new SlashExecutionService(
      new FakeSlashProposals() as never,
      { findOne: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      new FakeNotifications() as never,
      TEST_SLASH_CONFIG,
      null,
    );

    await expect(service.reconcileExecuting(NOW)).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_NOT_EXECUTED,
    });
  });
});

// ── What a voided provider is told, and what is counted ─

describe('what a voided case tells the provider about their stake', () => {
  it('says the reservation still stands, and when it is released, if the record does', async () => {
    // The case the two-phase slash introduced. A `VerifierRevoked` void at execution time
    // closes our case and leaves the on-chain record exactly where it was:
    // `Pending`, with the stake still reserved, until `expire_slash` becomes
    // permissionless at `executable_at + 7d`. The earlier sentence — "Any
    // stake it had reserved is released" — is the opposite of the truth here,
    // and this is provider-facing text on a money case.
    const { service, proposals, notifications, executor } = build();
    proposals.seed(executable({ id: 'p1', chainExecutableAt: hoursFromNow(-1) }));
    executor.executeImpl = async () => {
      throw executeRefusal(codeOf('VerifierRevoked'), 'this verifier key has been revoked');
    };

    await service.executeDue(NOW);

    const sent = notifications.sent.find((n) => n.event === 'provider.slash_decided')!;
    // The half that is still true, and the half that matters most to them.
    expect(sent.body).toContain('nothing was taken');
    expect(sent.body).toContain('still holds the stake it reserved');
    // `chain_executable_at + SLASH_EXECUTION_GRACE_SECONDS`, to the hour.
    const releasedAt = new Date(hoursFromNow(-1).getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(sent.body).toContain(releasedAt.toISOString());
    expect(sent.payload).toMatchObject({ reservationHeldUntil: releasedAt.toISOString() });
    // And it must NOT claim the release already happened.
    expect(sent.body).not.toContain('Any stake it had reserved is released');
  });

  it('says the reservation is released when the chain refused the proposal outright', async () => {
    // `REFUSED` means no record exists, so nothing was ever reserved. The
    // original sentence is correct here and must not be replaced with a
    // horizon there is no record to reach.
    const { service, proposals, notifications, executor } = build();
    proposals.seed(proposable({ id: 'p1' }));
    executor.proposeImpl = async () => {
      throw refusal(
        codeOf('PenaltyExceedsMaximum'),
        'the penalty is above this provider’s contract',
      );
    };

    await service.proposeDue(NOW);

    const sent = notifications.sent.find((n) => n.event === 'provider.slash_decided')!;
    expect(sent.body).toContain('Any stake it had reserved is released');
    expect(sent.body).not.toContain('still holds');
    expect(sent.payload).toMatchObject({ reservationHeldUntil: null });
  });

  it('says the reservation is released when the record was cancelled or expired', async () => {
    // `cancel_slash` and `expire_slash` release it in the same instruction.
    const { service, proposals, notifications, executor } = build();
    proposals.seed(orphaned({ id: 'p1' }));
    executor.readRecordImpl = async () =>
      chainRecord({ status: 'CANCELLED', executedAt: null, cancelledAt: hoursFromNow(-0.5) });

    await service.reconcileExecuting(NOW);

    const sent = notifications.sent.find((n) => n.event === 'provider.slash_decided')!;
    expect(sent.body).toContain('Any stake it had reserved is released');
    expect(sent.payload).toMatchObject({ reservationHeldUntil: null });
  });
});

describe('executeDue — one provider must not end the pass', () => {
  it('keeps going when the row cannot be marked after a failed execution', async () => {
    // The invariant the VOID branch already kept, on the branch that did not.
    // A bare `transitionIfIn`/`update` here would throw out of the `for` loop
    // and hold every later provider's harmed agent out of their compensation.
    const { service, proposals, executor } = build();
    proposals.seed(executable({ id: 'bad', chainExecutableAt: hoursFromNow(-2) }));
    proposals.seed(executable({ id: 'good', chainExecutableAt: hoursFromNow(-1) }));
    executor.executeImpl = async (request) => {
      if (request.requestId === requestIdOf('bad')) {
        throw executeRefusal(
          codeOf('VerifierDailyCapExceeded'),
          'the daily cap for this verifier key is spent',
        );
      }
      return {
        signature: 'sig-good',
        appliedMinor: '900',
        agentAmountMinor: '540',
        platformAmountMinor: '270',
        executedAt: NOW,
      };
    };
    const realTransition = proposals.transitionIfIn.bind(proposals);
    jest
      .spyOn(proposals, 'transitionIfIn')
      .mockImplementation(async (org, id, from, patch) =>
        id === 'bad' && patch.status === SlashProposalStatus.UPHELD
          ? Promise.reject(new Error('db went away'))
          : realTransition(org, id, from, patch),
      );

    expect(await service.executeDue(NOW)).toEqual({ executed: 1, voided: 0, failed: 1 });
    // The failed row stays EXECUTING and claimed, which the reconciler resolves
    // by reading the record — it is not stranded.
    expect(proposals.rows.get('bad')!.status).toBe(SlashProposalStatus.EXECUTING);
    // And the other provider's case went through.
    expect(proposals.rows.get('good')!.status).toBe(SlashProposalStatus.EXECUTED);
  });
});

describe('the counters report the chain, not the compare-and-swap', () => {
  it('compensates and counts an execution the row lost the race to record', async () => {
    // An operator suspended the case between the claim and the write. That
    // changes what the ROW says; it does not change that the chain took the
    // penalty and that the agent share is sitting in the vault. Reporting
    // `executed: 0` would be reporting on a race rather than on the chain, and
    // skipping the distribution would leave the harmed agents unpaid with
    // nobody looking.
    const compensation = { distribute: jest.fn().mockResolvedValue(1) };
    const { service, proposals, executor, notifications } = build({ compensation });
    proposals.seed(executable({ id: 'p1' }));
    executor.executeImpl = async () => {
      // The world moves while the transaction is confirming.
      proposals.rows.get('p1')!.status = SlashProposalStatus.CANCELLED;
      return {
        signature: 'sig-1',
        appliedMinor: '900',
        agentAmountMinor: '540',
        platformAmountMinor: '270',
        executedAt: NOW,
      };
    };

    expect(await service.executeDue(NOW)).toEqual({ executed: 1, voided: 0, failed: 0 });
    expect(compensation.distribute).toHaveBeenCalledTimes(1);
    // The row kept the status the other writer gave it, and nothing announced
    // an execution the row does not record.
    expect(proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.CANCELLED);
    expect(notifications.sent.map((n) => n.event)).not.toContain('provider.slash_executed');
  });

  it('does the same on the reconcile path, so the two agree', async () => {
    const compensation = { distribute: jest.fn().mockResolvedValue(1) };
    const { service, proposals, executor } = build({ compensation });
    proposals.seed(orphaned({ id: 'p1' }));
    executor.readRecordImpl = async () => {
      proposals.rows.get('p1')!.status = SlashProposalStatus.OVERTURNED;
      return chainRecord();
    };

    expect(await service.reconcileExecuting(NOW)).toEqual({
      recovered: 1,
      returned: 0,
      voided: 0,
    });
    expect(compensation.distribute).toHaveBeenCalledTimes(1);
    expect(proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.OVERTURNED);
  });
});

// ── Cancel on an overturn, cancel-and-re-propose on a recalculation ──

/** The refusal `cancel_slash` throws, built by the executor's own factory. */
function cancelRefusal(customErrorCode: number | null, reason: string) {
  return ChainErrors.transactionFailed({
    instruction: 'cancel_slash',
    signature: null,
    customErrorCode,
    reason,
  });
}

/** A row with a live reservation on chain: `Pending`, both clocks written. */
function standing(overrides: Partial<Parameters<FakeSlashProposals['seed']>[0]> & { id: string }) {
  return row({
    status: 'OVERTURNED',
    chainStatus: 'PENDING',
    chainProposedAt: hoursFromNow(-2),
    chainExecutableAt: hoursFromNow(70),
    chainReserved: '5000000',
    chainRequestId: requestIdOf(overrides.id),
    ...overrides,
  });
}

/**
 * A standing record whose clocks have already run out — the only shape a record
 * that somebody else EXECUTED can actually have.
 *
 * `standing()` puts `chain_executable_at` 70 hours out, which is right for a
 * live reservation and wrong the moment `chainRecord()` says the thing
 * executed at `NOW−0.5h`: `chk_slash_proposals_execution_respects_chain_timelock`
 * refuses `executed_at < chain_executable_at`, so a fixture pairing the two
 * asserts a row Postgres would reject and proves nothing about the one thing
 * these unit tests cannot otherwise check.
 */
function standingAndDue(
  overrides: Partial<Parameters<FakeSlashProposals['seed']>[0]> & { id: string },
) {
  return standing({
    chainProposedAt: hoursFromNow(-73),
    chainExecutableAt: hoursFromNow(-1),
    earliestExecutionAt: hoursFromNow(-1),
    ...overrides,
  });
}

describe('requestAdminCancel', () => {
  it('records that a case is due to be cancelled, and signs nothing', async () => {
    // The reservation is real money to the provider: `pending_slash` is
    // subtracted from `withdrawable`. But the program's `cancel_slash` is signed by
    // `Config.admin`, a person's hardware key — so this platform can only say
    // so and wait.
    const { service, proposals, executor, events } = build();
    proposals.seed(standing({ id: 'p1' }));

    await service.requestAdminCancel('org_1', 'p1', 'OVERTURNED_GRIEFING');

    expect(proposals.rows.get('p1')!.chainStatus).toBe('CANCEL_REQUESTED');
    expect(proposals.rows.get('p1')!.chainLastError).toBeNull();
    expect(events.kinds()).toContain('CHAIN_CANCEL_REQUESTED');
    // Nothing was built and nothing submitted — the intent route builds, on
    // demand, when an operator asks for it.
    expect(executor.cancelBuilds).toHaveLength(0);
  });

  it('takes the case out of the execute sweep, so this platform cannot spend it', async () => {
    // `findChainExecutable` selects `chain_status = 'PENDING'`. A distinct
    // status is what makes that predicate honour the withdrawal by
    // construction rather than by a second check somebody could forget.
    const { service, proposals } = build();
    proposals.seed(standingAndDue({ id: 'p1', status: 'UPHELD' }));

    expect(await proposals.findChainExecutable(NOW, 100)).toHaveLength(1);
    await service.requestAdminCancel('org_1', 'p1', 'the penalty was recalculated');
    expect(await proposals.findChainExecutable(NOW, 100)).toEqual([]);
  });

  it('is a no-op when nothing is standing on chain', async () => {
    const { service, proposals, events } = build();
    proposals.seed(standing({ id: 'p1', chainStatus: 'NONE' }));

    await service.requestAdminCancel('org_1', 'p1', 'OVERTURNED_GRIEFING');

    expect(proposals.rows.get('p1')!.chainStatus).toBe('NONE');
    expect(events.kinds()).not.toContain('CHAIN_CANCEL_REQUESTED');
  });

  it('does not ask twice for the same case', async () => {
    const { service, proposals, events } = build();
    proposals.seed(standing({ id: 'p1' }));

    await service.requestAdminCancel('org_1', 'p1', 'OVERTURNED_GRIEFING');
    await service.requestAdminCancel('org_1', 'p1', 'OVERTURNED_GRIEFING');

    expect(events.kinds().filter((kind) => kind === 'CHAIN_CANCEL_REQUESTED')).toHaveLength(1);
  });
});

/**
 * The repair behind every best-effort cancel request: a case closed off chain
 * (suspended, or overturned) whose record still mirrors `PENDING` is watched by
 * nothing — the execute sweep wants `UPHELD`, the admin-cancel sweep wants
 * `CANCEL_REQUESTED` — while its stake stays reserved and anyone may execute it
 * once the timelock passes.
 */
describe('requestCancelsForClosedCases', () => {
  it.each([SlashProposalStatus.CANCELLED, SlashProposalStatus.OVERTURNED])(
    'asks for the cancel of a %s case whose record is still PENDING',
    async (status) => {
      const { service, proposals, events, executor } = build();
      proposals.seed(standing({ id: 'p1', status }));

      await expect(service.requestCancelsForClosedCases()).resolves.toBe(1);

      expect(proposals.rows.get('p1')!.chainStatus).toBe('CANCEL_REQUESTED');
      expect(proposals.rows.get('p1')!.status).toBe(status);
      expect(events.kinds()).toContain('CHAIN_CANCEL_REQUESTED');
      // Records the request and nothing else: no transaction is built or sent.
      expect(executor.cancelBuilds).toHaveLength(0);
      expect(executor.expired).toHaveLength(0);
    },
  );

  it('is idempotent: a second pass finds nothing and appends nothing', async () => {
    const { service, proposals, events } = build();
    proposals.seed(standing({ id: 'p1', status: SlashProposalStatus.CANCELLED }));

    await service.requestCancelsForClosedCases();
    await expect(service.requestCancelsForClosedCases()).resolves.toBe(0);

    expect(events.kinds().filter((kind) => kind === 'CHAIN_CANCEL_REQUESTED')).toHaveLength(1);
  });

  it('leaves every other case alone', async () => {
    const { service, proposals, events } = build();
    // A live judgement: the record is supposed to stand.
    proposals.seed(standing({ id: 'live', status: SlashProposalStatus.UPHELD }));
    // Closed with nothing on chain, already asked for, already released.
    proposals.seed(standing({ id: 'none', status: 'CANCELLED', chainStatus: 'NONE' }));
    proposals.seed(standing({ id: 'asked', status: 'CANCELLED', chainStatus: 'CANCEL_REQUESTED' }));
    proposals.seed(standing({ id: 'released', status: 'OVERTURNED', chainStatus: 'CANCELLED' }));
    // In flight: `proposeOne` asks when the record lands.
    proposals.seed(standing({ id: 'flying', status: 'CANCELLED', chainStatus: 'PROPOSING' }));
    // Voided by the chain at execution time: deliberately left PENDING today,
    // and not a decision this repair takes.
    proposals.seed(
      standing({
        id: 'voided',
        status: 'CANCELLED',
        resolutionKind: ResolutionKind.AUTO_CHAIN_VOIDED,
        resolvedAt: NOW,
      }),
    );

    await expect(service.requestCancelsForClosedCases()).resolves.toBe(0);

    expect([...proposals.rows.values()].map((saved) => [saved.id, saved.chainStatus])).toEqual([
      ['live', 'PENDING'],
      ['none', 'NONE'],
      ['asked', 'CANCEL_REQUESTED'],
      ['released', 'CANCELLED'],
      ['flying', 'PROPOSING'],
      ['voided', 'PENDING'],
    ]);
    expect(events.kinds()).not.toContain('CHAIN_CANCEL_REQUESTED');
  });

  it('is bounded by the sweep batch size', async () => {
    const { service, proposals } = build();
    const find = jest.spyOn(proposals, 'findClosedStillPending');

    await service.requestCancelsForClosedCases();

    expect(find).toHaveBeenCalledWith(TEST_SLASH_CONFIG.sweepBatchSize);
  });

  it('does not count a case that could not be marked', async () => {
    const { service, proposals } = build();
    proposals.seed(standing({ id: 'p1', status: SlashProposalStatus.CANCELLED }));
    proposals.seed(standing({ id: 'p2', status: SlashProposalStatus.CANCELLED }));
    const update = proposals.update.bind(proposals);
    jest.spyOn(proposals, 'update').mockImplementation(async (criteria, patch) => {
      if (criteria.id === 'p1') throw new Error('database unavailable');
      return update(criteria, patch);
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.requestCancelsForClosedCases()).resolves.toBe(1);

    expect(proposals.rows.get('p1')!.chainStatus).toBe('PENDING');
    expect(proposals.rows.get('p2')!.chainStatus).toBe('CANCEL_REQUESTED');
    error.mockRestore();
  });
});

describe('buildCancelIntent', () => {
  it('hands back the admin’s unsigned transaction and changes nothing', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(standing({ id: 'p1', chainStatus: 'CANCEL_REQUESTED' }));

    const intent = await service.buildCancelIntent('org_1', 'p1');

    expect(intent.transaction).toBe('unsigned_cancel_1');
    expect(executor.cancelBuilds).toEqual([
      { chainId: CHAIN_IDS.SOLANA_DEVNET, requestId: requestIdOf('p1'), provider: 'StakeAuth9999' },
    ]);
    // The case moves when the record leaves `Pending`, never because somebody
    // was handed a transaction.
    expect(proposals.rows.get('p1')!.chainStatus).toBe('CANCEL_REQUESTED');
  });

  /**
   * A `cancel_slash` for a judgement nobody decided to withdraw is a
   * transaction that drops a standing penalty once the admin signs it. The
   * route builds one only for a case waiting on exactly that signature, and the
   * refusal names this action — it used to fall through to a lookup that
   * answered "nothing to compensate".
   */
  it.each(['NONE', 'PROPOSING', 'PENDING', 'EXECUTED', 'CANCELLED', 'REFUSED'])(
    'refuses to build a cancel while the chain record is %s',
    async (chainStatus) => {
      const { service, proposals, executor } = build();
      proposals.seed(standing({ id: 'p1', chainStatus }));

      await expect(service.buildCancelIntent('org_1', 'p1')).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION,
        statusCode: 409,
        message: expect.stringContaining('Cannot build the cancel transaction'),
      });
      expect(executor.cancelBuilds).toEqual([]);
    },
  );

  /**
   * The refusal for a provider with no proved stake authority used to be
   * `SLASH_NOT_EXECUTED` — "Nothing to compensate: this proposal never
   * executed" — on a route that compensates nothing.
   */
  it('names the missing stake authority when the provider never proved one', async () => {
    const { service, proposals, enrolments, executor } = build();
    proposals.seed(standing({ id: 'p1', chainStatus: 'CANCEL_REQUESTED' }));
    enrolments.findOneBy.mockResolvedValue({
      organizationId: 'org-1',
      stakeAuthorityAccountId: null,
    });

    await expect(service.buildCancelIntent('org_1', 'p1')).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_UNPROVEN,
      statusCode: 409,
      message: expect.stringMatching(/no proved stake authority on .+ no transaction can be built/),
    });
    expect(executor.cancelBuilds).toEqual([]);
  });
});

describe('sweepAdminCancels', () => {
  it('mirrors CANCELLED once the admin’s transaction has landed', async () => {
    // This is what closes the loop: the platform asked, a human signed, and the
    // sweep is what notices — read from the record, never assumed.
    const { service, proposals, executor } = build();
    proposals.seed(standing({ id: 'p1', chainStatus: 'CANCEL_REQUESTED' }));
    executor.readRecordImpl = async () =>
      chainRecord({ status: 'CANCELLED', executedAt: null, cancelledAt: hoursFromNow(-1) });

    await expect(service.sweepAdminCancels(NOW)).resolves.toEqual({
      mirrored: 1,
      expired: 0,
      waiting: 0,
    });
    expect(proposals.rows.get('p1')!.chainStatus).toBe('CANCELLED');
  });

  it('leaves a record nobody has signed for alone while its grace is running', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(standing({ id: 'p1', chainStatus: 'CANCEL_REQUESTED' }));
    executor.readRecordImpl = async () => chainRecord({ status: 'PENDING', executedAt: null });

    await expect(service.sweepAdminCancels(NOW)).resolves.toEqual({
      mirrored: 0,
      expired: 0,
      waiting: 1,
    });
    expect(executor.expired).toHaveLength(0);
    expect(proposals.rows.get('p1')!.chainStatus).toBe('CANCEL_REQUESTED');
  });

  it('expires a record the admin never cancelled, once its seven-day grace has run', async () => {
    // `expire_slash` is permissionless, which is the whole answer to "what if
    // nobody signs it": the provider's capital is released without a human.
    const { service, proposals, executor, events } = build();
    proposals.seed(
      standing({
        id: 'p1',
        chainStatus: 'CANCEL_REQUESTED',
        chainProposedAt: hoursFromNow(-24 * 11),
        chainExecutableAt: hoursFromNow(-24 * 8),
      }),
    );
    executor.readRecordImpl = async () =>
      chainRecord({ status: 'PENDING', executedAt: null, executableAt: hoursFromNow(-24 * 8) });

    await expect(service.sweepAdminCancels(NOW)).resolves.toEqual({
      mirrored: 0,
      expired: 1,
      waiting: 0,
    });
    expect(executor.expired).toEqual([
      { chainId: CHAIN_IDS.SOLANA_DEVNET, requestId: requestIdOf('p1'), provider: 'StakeAuth9999' },
    ]);
    expect(proposals.rows.get('p1')!.chainStatus).toBe('CANCELLED');
    expect(events.kinds()).toContain('CHAIN_CANCELLED');
  });

  it('does not expire one whose grace has not run, even by an hour', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(
      standing({
        id: 'p1',
        chainStatus: 'CANCEL_REQUESTED',
        chainProposedAt: hoursFromNow(-24 * 10),
        chainExecutableAt: hoursFromNow(-24 * 7 + 1),
      }),
    );
    executor.readRecordImpl = async () => chainRecord({ status: 'PENDING', executedAt: null });

    await service.sweepAdminCancels(NOW);

    expect(executor.expired).toHaveLength(0);
  });

  it('records a refused expiry without claiming the record is gone', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(
      standing({
        id: 'p1',
        chainStatus: 'CANCEL_REQUESTED',
        chainProposedAt: hoursFromNow(-24 * 11),
        chainExecutableAt: hoursFromNow(-24 * 8),
      }),
    );
    executor.readRecordImpl = async () =>
      chainRecord({ status: 'PENDING', executedAt: null, executableAt: hoursFromNow(-24 * 8) });
    executor.expireImpl = async () => {
      throw cancelRefusal(codeOf('SlashNotExpired'), 'the record is not expired');
    };

    await expect(service.sweepAdminCancels(NOW)).resolves.toEqual({
      mirrored: 0,
      expired: 0,
      waiting: 1,
    });
    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('CANCEL_REQUESTED');
    expect(saved.chainLastError).toBe('SlashNotExpired');
  });

  it('never reports a cancellation for a record that was in fact executed', async () => {
    // The third way out of `Pending` is `Executed`, and `execute_slash` is
    // permissionless. Writing CANCELLED without looking would tell the provider
    // a penalty was dropped that a stranger had just taken.
    const { service, proposals, executor, events } = build();
    proposals.seed(
      standingAndDue({ id: 'p1', chainStatus: 'CANCEL_REQUESTED', penaltyAmount: '5000000' }),
    );
    executor.readRecordImpl = async () =>
      chainRecord({
        status: 'EXECUTED',
        penaltyMinor: '5000000',
        appliedMinor: '900',
        agentAmountMinor: '540',
        platformAmountMinor: '270',
      });

    await service.sweepAdminCancels(NOW);

    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('EXECUTED');
    // The money is ON the row — and the adjudicator's decision is still there
    // beside it. A chain event may not overwrite a human.
    expect(saved.status).toBe(SlashProposalStatus.OVERTURNED);
    expect(saved.appliedAmount).toBe('900');
    expect(saved.platformAmount).toBe('270');
    expect(saved.executedAt).toEqual(hoursFromNow(-0.5));
    expect(saved.executionSignature).toBeNull();
    expect(events.kinds()).toContain('EXECUTED_AFTER_CLOSURE');
  });

  /**
   * The same door on a SUSPENDED case: the cancel was requested, nobody signed
   * it before the timelock ran out, and a third party executed the record.
   * The row has to say the money moved and still say an operator suspended it.
   */
  it('records an execution of a suspended case beside the suspension', async () => {
    const { service, proposals, executor, events } = build();
    proposals.seed(
      standingAndDue({
        id: 'p1',
        status: SlashProposalStatus.CANCELLED,
        chainStatus: 'CANCEL_REQUESTED',
        penaltyAmount: '5000000',
      }),
    );
    executor.readRecordImpl = async () =>
      chainRecord({ status: 'EXECUTED', penaltyMinor: '5000000', appliedMinor: '900' });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await service.sweepAdminCancels(NOW);

    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.CANCELLED);
    expect(saved.chainStatus).toBe('EXECUTED');
    expect(saved.appliedAmount).toBe('900');
    expect(saved.executedAt).toEqual(hoursFromNow(-0.5));
    expect(saved.executionSignature).toBeNull();
    const event = events.rows.find((row) => row.kind === 'EXECUTED_AFTER_CLOSURE');
    expect(event?.detail).toMatchObject({ applied: '900', caseStatus: 'CANCELLED' });
    // Loud for the operator on call, and out of the admin-cancel sweep for good.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('was CLOSED (CANCELLED)'));
    expect(await proposals.findAwaitingAdminCancel(100)).toEqual([]);
    error.mockRestore();
  });

  /**
   * The loop this branch exists to avoid.
   *
   * `reconcileExecuting` completes a park with
   * `completeExecution(…, CHAIN_PROPOSABLE_STATUSES)`, and `OVERTURNED` is not
   * in that list — so a row handed over with `executed_at` still null would
   * lose the CAS, keep matching the predicate, and burn one `readRecord` RPC
   * and one `compensate` every minute for ever.
   */
  it('leaves a post-closure execution out of the reconcile sweep entirely', async () => {
    const { service, proposals, executor, compensation } = build({
      compensation: { distribute: jest.fn().mockResolvedValue(1) },
    });
    proposals.seed(
      standingAndDue({ id: 'p1', chainStatus: 'CANCEL_REQUESTED', penaltyAmount: '5000000' }),
    );
    executor.readRecordImpl = async () => chainRecord({ status: 'EXECUTED' });

    await service.sweepAdminCancels(NOW);

    expect(await proposals.findExecutingToReconcile(TEN_MINUTES_AGO, 100)).toEqual([]);

    const readsBefore = executor.recordReads.length;
    expect(await service.reconcileExecuting(NOW)).toEqual({
      recovered: 0,
      returned: 0,
      voided: 0,
    });
    expect(executor.recordReads).toHaveLength(readsBefore);
    // The agent share is attributed once, where it already sits in the vault.
    expect(compensation!.distribute).toHaveBeenCalledTimes(1);
  });

  /**
   * `chk_slash_proposals_applied_within_penalty` is `applied_amount <= penalty_amount`.
   * A downward recalculation is the one path that can make `applied` the larger
   * number, and neither way out of that is honest — so the row records a marker
   * and a human is told.
   */
  it('refuses to record an execution larger than the case says was owed', async () => {
    const { service, proposals, executor, compensation } = build({
      compensation: { distribute: jest.fn().mockResolvedValue(1) },
    });
    proposals.seed(
      standingAndDue({
        id: 'p1',
        status: 'UPHELD',
        chainStatus: 'CANCEL_REQUESTED',
        penaltyAmount: '400000',
      }),
    );
    executor.readRecordImpl = async () =>
      chainRecord({ status: 'EXECUTED', appliedMinor: '5000000' });

    await service.sweepAdminCancels(NOW);

    const saved = proposals.rows.get('p1')!;
    // Nothing that the database would refuse, and nothing invented.
    expect(saved.executedAt).toBeNull();
    expect(saved.appliedAmount).toBeNull();
    expect(saved.chainLastError).toBe('ExecutedBeyondDecision');
    // The agent share still moved, so it is still attributed.
    expect(compensation!.distribute).toHaveBeenCalledTimes(1);
  });

  /**
   * The row cannot record the execution; the LEDGER still must.
   *
   * The chain has already moved the agent share into the vault, so skipping
   * the distribution here would leave money that left the provider credited to
   * nobody.
   */
  it('credits the agents even when the execution cannot be recorded on the row', async () => {
    const { service, proposals, executor, compensation } = build({
      compensation: { distribute: jest.fn().mockResolvedValue(2) },
    });
    proposals.seed(
      standingAndDue({
        id: 'p1',
        status: 'UPHELD',
        chainStatus: 'CANCEL_REQUESTED',
        penaltyAmount: '400000',
      }),
    );
    executor.readRecordImpl = async () =>
      chainRecord({ status: 'EXECUTED', appliedMinor: '5000000', agentAmountMinor: '3000000' });

    await service.sweepAdminCancels(NOW);

    const saved = proposals.rows.get('p1')!;
    expect(saved.executedAt).toBeNull();
    expect(saved.chainLastError).toBe('ExecutedBeyondDecision');

    // The figures come off the CHAIN, never from `penaltyAmount` — that is
    // precisely the number the chain disagreed with.
    expect(compensation!.distribute).toHaveBeenCalledWith(
      expect.objectContaining({
        agentAmountMinor: '3000000',
        // Stable and non-null, which is what makes the ledger's unique index a
        // real idempotency key.
        signature: saved.chainRequestId,
        windowId: saved.windowId,
        providerId: saved.providerId,
      }),
    );
  });

  it('completes a still-live case the ordinary way when a stranger executed it', async () => {
    // `UPHELD → EXECUTED` is the transition that was going to happen anyway, so
    // this is not a chain event overwriting a human and the shared writer is
    // the right one. It also leaves the case compensable: the compensation
    // routes gate on the money columns this writes.
    const { service, proposals, events, executor, notifications } = build();
    proposals.seed(
      standingAndDue({
        id: 'p1',
        status: 'UPHELD',
        chainStatus: 'CANCEL_REQUESTED',
        penaltyAmount: '5000000',
      }),
    );
    executor.readRecordImpl = async () => chainRecord({ status: 'EXECUTED' });

    await service.sweepAdminCancels(NOW);

    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.EXECUTED);
    expect(saved.appliedAmount).toBe('900');
    expect(saved.executionSignature).toBeNull();
    expect(events.kinds()).toContain('EXECUTED');
    expect(notifications.sent.map((n) => n.event)).toContain('provider.slash_executed');
  });
});

describe('reproposeAtRevisedPenalty', () => {
  it('asks for the admin cancel first, and does NOT bump the epoch yet', async () => {
    // `execute_slash` takes no amount argument: it applies
    // `min(record.penalty, …)`. A record frozen at 5.00 would take 5.00 however
    // far the adjudicator reduced it, so the old record has to go — but the program
    // makes that a human's signature, so this half only asks.
    //
    // Bumping the epoch now would be the failure this ordering exists to
    // prevent: a fresh request id with the old record still `Pending` reserves
    // the stake TWICE, and `propose_slash`'s `init` cannot refuse it because
    // the second id is genuinely unused.
    const { service, proposals, executor, events } = build();
    proposals.seed(
      standing({ id: 'p1', status: 'UPHELD', chainEpoch: 0, penaltyAmount: '400000' }),
    );

    await service.reproposeAtRevisedPenalty('org_1', 'p1');

    const saved = proposals.rows.get('p1')!;
    expect(saved.chainStatus).toBe('CANCEL_REQUESTED');
    expect(saved.chainEpoch).toBe(0);
    expect(saved.chainRequestId).toBe(requestIdOf('p1'));
    expect(executor.proposed).toHaveLength(0);
    expect(events.kinds()).toContain('CHAIN_CANCEL_REQUESTED');
  });

  it('proposes the revised figure under a fresh id once the record is off the chain', async () => {
    // The second half, days later: the admin signed (or the sweep expired the
    // record), the mirror says `CANCELLED`, and the fresh epoch may go.
    const { service, proposals, executor } = build();
    proposals.seed(
      standing({
        id: 'p1',
        status: 'UPHELD',
        chainEpoch: 0,
        penaltyAmount: '400000',
        chainStatus: 'CANCELLED',
      }),
    );
    executor.appliedMinor = '400000';

    await service.reproposeAtRevisedPenalty('org_1', 'p1');

    const saved = proposals.rows.get('p1')!;
    expect(saved.chainEpoch).toBe(1);
    expect(saved.chainRequestId).toBe(deriveChainRequestId({ id: 'p1', chainEpoch: 1 }));
    expect(saved.chainStatus).toBe('PENDING');
    expect(executor.proposed).toHaveLength(1);
    expect(executor.proposed[0].requestId).toBe(deriveChainRequestId({ id: 'p1', chainEpoch: 1 }));
    expect(executor.proposed[0].penaltyMinor).toBe('400000');
    // The provider waits another 72h. That is the price of paying the figure
    // the adjudicator actually decided rather than the one that was frozen.
    expect(saved.chainExecutableAt).toEqual(new Date('2026-08-13T09:15:00Z'));
  });

  it('says so loudly when the fresh epoch id is spent as well', async () => {
    // `proposeOne` returns the status it mirrored. Ignoring a non-PENDING
    // answer would leave the case believing it has a live proposal when the
    // request id it just moved to is already occupied by a dead record.
    const { service, proposals, executor } = build();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    proposals.seed(
      standing({
        id: 'p1',
        status: 'UPHELD',
        chainEpoch: 0,
        penaltyAmount: '400000',
        chainStatus: 'CANCELLED',
      }),
    );
    executor.proposeImpl = async () => ({
      signature: '',
      status: 'CANCELLED',
      proposedAt: hoursFromNow(-100),
      executableAt: hoursFromNow(-28),
      reservedMinor: '400000',
      adopted: true,
    });

    await service.reproposeAtRevisedPenalty('org_1', 'p1');

    const saved = proposals.rows.get('p1')!;
    expect(saved.chainEpoch).toBe(1);
    expect(saved.chainStatus).not.toBe('PENDING');
    expect(error.mock.calls.flat().join('\n')).toMatch(/spent|already/i);
    error.mockRestore();
  });

  it('keeps the standing record when the recalculation did not lower it below the reservation', async () => {
    // `UPHELD_RECALCULATED` is allowed to land on the figure that was already
    // there. Cancelling then would cost the provider another 72 hours for an
    // identical judgement, and the chain could never have overtaken the
    // decision: `applied <= reserved <= penalty`.
    const { service, proposals, executor } = build();
    proposals.seed(
      standing({ id: 'p1', status: 'UPHELD', penaltyAmount: '5000000', chainReserved: '5000000' }),
    );

    await service.reproposeAtRevisedPenalty('org_1', 'p1');

    expect(executor.proposed).toHaveLength(0);
    const saved = proposals.rows.get('p1')!;
    expect(saved.chainEpoch).toBe(0);
    expect(saved.chainStatus).toBe('PENDING');
    expect(saved.chainRequestId).toBe(requestIdOf('p1'));
  });

  it('does nothing when there is no standing proposal to replace', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(standing({ id: 'p1', status: 'UPHELD', chainStatus: 'NONE' }));

    await service.reproposeAtRevisedPenalty('org_1', 'p1');

    expect(executor.proposed).toHaveLength(0);
    expect(proposals.rows.get('p1')!.chainEpoch).toBe(0);
  });
});

describe('executeDue — a penalty an adjudicator lowered after the chain froze it', () => {
  /**
   * The hole the decide-time call cannot close on its own.
   *
   * `decide()` runs in the API process, and `SolanaSlashExecutor` resolves
   * `VerifierSigningService` through `ModuleRef` at call time — a lookup that
   * only the scheduler and worker bootstraps can satisfy. So a recalculation
   * decided on an API pod cannot cancel anything, and without this guard the
   * scheduler would then execute the record frozen at the ORIGINAL figure and
   * take more than the adjudicator decided.
   */
  it('re-proposes instead of executing when the record could take more than was decided', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(
      executable({
        id: 'p1',
        // What the adjudicator decided, after `UPHELD_RECALCULATED`.
        penaltyAmount: '400000',
        // What the chain froze at proposal time, and the ceiling `execute_slash`
        // applies `min()` against.
        chainReserved: '1000000',
      }),
    );
    executor.appliedMinor = '400000';

    const result = await service.executeDue(NOW);

    expect(executor.executed).toHaveLength(0);
    expect(result).toEqual({ executed: 0, voided: 0, failed: 0 });
    const saved = proposals.rows.get('p1')!;
    expect(saved.status).toBe(SlashProposalStatus.UPHELD);
    // Lean v3: the epoch is NOT bumped here. The record is asked to be
    // cancelled by the admin and the re-proposal happens on a later tick, once
    // `sweepAdminCancels` has mirrored `CANCELLED`.
    expect(saved.chainEpoch).toBe(0);
    expect(saved.chainStatus).toBe('CANCEL_REQUESTED');
    expect(executor.proposed).toHaveLength(0);
    // And it is out of the execute sweep from this moment.
    expect(await proposals.findChainExecutable(NOW, 100)).toEqual([]);
  });

  /**
   * The loop-critical branch, proved by the marker rather than by the fixture.
   *
   * The row here IS due — `findChainExecutable` selects it, which the second
   * half of this test demonstrates by clearing the marker and running the very
   * same pass. So the first half's silence is the `continue` at the top of
   * `executeDue`'s loop, and not a row that was never picked up.
   */
  it('skips a row already diagnosed as executed beyond the decision', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(
      executable({
        id: 'p1',
        penaltyAmount: '400000',
        chainReserved: '1000000',
        chainLastError: 'ExecutedBeyondDecision',
      }),
    );

    // Selected by the query — the marker is the only thing between this row and
    // the work below.
    expect(await proposals.findChainExecutable(NOW, 100)).toEqual([
      { organizationId: 'org_1', id: 'p1' },
    ]);

    expect(await service.executeDue(NOW)).toEqual({ executed: 0, voided: 0, failed: 0 });
    // Not one RPC: no execute, and — the expensive half the marker buys — no
    // cancel request and no re-propose either.
    expect(executor.executed).toHaveLength(0);
    expect(executor.proposed).toHaveLength(0);
    expect(proposals.rows.get('p1')!.chainStatus).toBe('PENDING');

    // Same row, same pass, marker gone.
    proposals.rows.get('p1')!.chainLastError = null;
    await service.executeDue(NOW);

    expect(proposals.rows.get('p1')!.chainStatus).toBe('CANCEL_REQUESTED');
  });

  it('does not end the pass when the comparison itself throws', async () => {
    // The guard sits inside the per-row `try`. A malformed amount must cost one
    // row, never the batch — the same isolation every other failure in this
    // loop already has.
    const { service, proposals, executor } = build();
    proposals.seed(executable({ id: 'bad', penaltyAmount: 'not-a-number' }));
    proposals.seed(executable({ id: 'good', penaltyAmount: '1000000' }));

    const result = await service.executeDue(NOW);

    expect(result).toEqual({ executed: 1, voided: 0, failed: 1 });
    expect(executor.executed.map((call) => call.requestId)).toEqual([requestIdOf('good')]);
  });

  it('executes normally when the reservation is within what was decided', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(executable({ id: 'p1', penaltyAmount: '1000000', chainReserved: '1000000' }));

    const result = await service.executeDue(NOW);

    expect(result).toEqual({ executed: 1, voided: 0, failed: 0 });
    expect(executor.executed).toHaveLength(1);
    expect(proposals.rows.get('p1')!.chainStatus).not.toBe('CANCEL_REQUESTED');
  });
});

describe('the fleet sweep asks for the chain reservation to be released too', () => {
  // `openSweep` measures its lookback from the real clock, so the candidates
  // have to be proposed against it rather than against this suite's frozen NOW.
  const RECENTLY = new Date(Date.now() - 60 * 60 * 1000);

  /**
   * The fourth of the four places a case stops standing, and the one that most
   * needs the cancel: `findSweepCandidates` carries **no clock at all** and
   * reaches cases from `UPHELD`, so it routinely overturns a case whose
   * on-chain record has been executable for days. `execute_slash` is
   * permissionless, so a provider swept clear of a defect that was never theirs
   * would otherwise keep a `Pending` record any stranger can spend.
   *
   * This only *records* the request — which is also why it now
   * works identically in the API pod, where no signing capability exists.
   */
  it('requests a cancel for every case it overturns, and not for the source case', async () => {
    const { service, proposals, events } = build();
    proposals.seed(
      standing({
        id: 'source',
        status: 'OVERTURNED',
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        rootCauseKey: 'mapping/v3',
        proposedAt: RECENTLY,
        chainStatus: 'CANCELLED',
      }),
    );
    proposals.seed(
      standing({
        id: 'swept',
        status: 'UPHELD',
        rootCauseKey: 'mapping/v3',
        proposedAt: RECENTLY,
      }),
    );

    await service.openSweep(OPERATOR as never, APPROVER as never, 'org_1', 'source', {
      defectKey: 'mapping/v3',
      lookbackHours: 72,
      reasonCode: 'S11_PLATFORM_DEFECT',
      note: 'the v3 binding dropped a field on every tool it touched',
    });

    expect(proposals.rows.get('swept')!.status).toBe(SlashProposalStatus.OVERTURNED);
    expect(proposals.rows.get('swept')!.chainStatus).toBe('CANCEL_REQUESTED');
    // The source case is skipped by `applySweep`, and its own reservation was
    // dealt with when it was decided.
    expect(proposals.rows.get('source')!.chainStatus).toBe('CANCELLED');
    expect(events.kinds().filter((kind) => kind === 'CHAIN_CANCEL_REQUESTED')).toHaveLength(1);
  });

  /**
   * A sweep carries a decision to other cases, so a case with no decision has
   * nothing to carry. That is a wrong-status refusal, and it used to be
   * reported as an outcome called "no decision" that "is a finding about one
   * provider".
   */
  it.each(['PROPOSED', 'DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND', 'UPHELD', 'CANCELLED'])(
    'refuses to sweep from an undecided %s case',
    async (status) => {
      const { service, proposals } = build();
      proposals.seed(standing({ id: 'source', status, outcome: null, rootCauseKey: 'mapping/v3' }));

      await expect(
        service.openSweep(OPERATOR as never, APPROVER as never, 'org_1', 'source', {
          defectKey: 'mapping/v3',
          lookbackHours: 72,
          reasonCode: 'S11_PLATFORM_DEFECT',
          note: 'the v3 binding dropped a field on every tool it touched',
        }),
      ).rejects.toMatchObject({
        errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION,
        statusCode: 409,
        message:
          `Cannot open a fleet sweep while the case is ${status}; only while it is decided as ` +
          `a platform or policy defect`,
      });
    },
  );

  it('names the outcome when the decision is one that does not generalise', async () => {
    const { service, proposals } = build();
    proposals.seed(
      standing({
        id: 'source',
        status: 'OVERTURNED',
        outcome: ArbitrationOutcome.OVERTURNED_GRIEFING,
        rootCauseKey: 'mapping/v3',
      }),
    );

    await expect(
      service.openSweep(OPERATOR as never, APPROVER as never, 'org_1', 'source', {
        defectKey: 'mapping/v3',
        lookbackHours: 72,
        reasonCode: 'S11_PLATFORM_DEFECT',
        note: 'the v3 binding dropped a field on every tool it touched',
      }),
    ).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_SWEEP_OUTCOME_NOT_SWEEPABLE,
      statusCode: 422,
      message: expect.stringContaining('OVERTURNED_GRIEFING is a finding about one provider'),
    });
  });

  it('marks every swept case, not just the first', async () => {
    const { service, proposals } = build();
    proposals.seed(
      standing({
        id: 'source',
        status: 'OVERTURNED',
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        rootCauseKey: 'mapping/v3',
        proposedAt: RECENTLY,
        chainStatus: 'CANCELLED',
      }),
    );
    proposals.seed(
      standing({ id: 'a', status: 'UPHELD', rootCauseKey: 'mapping/v3', proposedAt: RECENTLY }),
    );
    proposals.seed(
      standing({ id: 'b', status: 'UPHELD', rootCauseKey: 'mapping/v3', proposedAt: RECENTLY }),
    );

    await service.openSweep(OPERATOR as never, APPROVER as never, 'org_1', 'source', {
      defectKey: 'mapping/v3',
      lookbackHours: 72,
      reasonCode: 'S11_PLATFORM_DEFECT',
      note: 'the v3 binding dropped a field on every tool it touched',
    });

    for (const id of ['a', 'b']) {
      expect(proposals.rows.get(id)!.status).toBe(SlashProposalStatus.OVERTURNED);
      expect(proposals.rows.get(id)!.chainStatus).toBe('CANCEL_REQUESTED');
    }
  });

  /**
   * BUG-R11-O1-02: the route built its 201 body from the row as first saved,
   * `OPEN` with zero counts, while the stored row was already `COMPLETED`.
   */
  it('returns the sweep as stored: completed, with its matched and applied counts', async () => {
    const { service, proposals } = build();
    proposals.seed(
      standing({
        id: 'source',
        status: 'OVERTURNED',
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        rootCauseKey: 'mapping/v3',
        proposedAt: RECENTLY,
        chainStatus: 'CANCELLED',
      }),
    );
    proposals.seed(
      standing({ id: 'a', status: 'UPHELD', rootCauseKey: 'mapping/v3', proposedAt: RECENTLY }),
    );
    proposals.seed(
      standing({ id: 'b', status: 'UPHELD', rootCauseKey: 'mapping/v3', proposedAt: RECENTLY }),
    );

    const sweep = await service.openSweep(OPERATOR as never, APPROVER as never, 'org_1', 'source', {
      defectKey: 'mapping/v3',
      lookbackHours: 72,
      reasonCode: 'S11_PLATFORM_DEFECT',
      note: 'the v3 binding dropped a field on every tool it touched',
    });

    expect(sweep).toMatchObject({ status: 'COMPLETED', matchedCount: 2, appliedCount: 2 });
    expect(sweep.completedAt).toBeInstanceOf(Date);
  });

  /**
   * BUG-R11-O1-03: a swept case kept its dispute `UNDER_REVIEW` with the
   * outcome it was overturned from. The sweep closes it as a decision does.
   */
  it('closes the dispute of a swept case with the sweep outcome', async () => {
    const { service, proposals, overrides } = build();
    proposals.seed(
      standing({
        id: 'source',
        status: 'OVERTURNED',
        outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        rootCauseKey: 'mapping/v3',
        proposedAt: RECENTLY,
        chainStatus: 'CANCELLED',
      }),
    );
    proposals.seed(
      standing({
        id: 'disputed',
        organizationId: 'org_2',
        status: 'AWAITING_SECOND',
        rootCauseKey: 'mapping/v3',
        proposedAt: RECENTLY,
        disputeId: 'dispute_1',
      }),
    );
    proposals.seed(
      standing({ id: 'plain', status: 'UPHELD', rootCauseKey: 'mapping/v3', proposedAt: RECENTLY }),
    );

    await service.openSweep(OPERATOR as never, APPROVER as never, 'org_1', 'source', {
      defectKey: 'mapping/v3',
      lookbackHours: 72,
      reasonCode: 'S11_PLATFORM_DEFECT',
      note: 'the v3 binding dropped a field on every tool it touched',
    });

    const disputeWrites = overrides.updates.filter(({ entity }) => entity === DisputeEntity);
    expect(disputeWrites).toHaveLength(1);
    expect(disputeWrites[0].criteria).toEqual({ organizationId: 'org_2', id: 'dispute_1' });
    expect(disputeWrites[0].patch).toMatchObject({
      state: 'UPHELD',
      outcome: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
      resolutionKind: ResolutionKind.ADJUDICATOR,
      resolvedBy: OPERATOR.subject,
      secondedByOperatorId: null,
      secondedAt: null,
      secondKind: null,
    });
    expect(disputeWrites[0].patch.resolvedAt).toBeInstanceOf(Date);
  });
});

describe('review fix S2-3 — no single-beneficiary slash on EVM', () => {
  const EVM_USDG = 'eip155:46630/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3';

  it('refuses to propose an EVM case through the single path, even with a stamped beneficiary', async () => {
    // An older row may carry the escrow contract (the old "vault") as its
    // beneficiary. On EVM that address credits nobody; the case must not be
    // signed for at all until a call-level rule exists.
    const { service, proposals, executor } = build();
    proposals.seed(
      proposable({
        id: 'p1',
        assetId: EVM_USDG,
        windowId: null,
        beneficiaryAccount: 'eip155:46630:0x1D26000000000000000000000000000000000f41',
      }),
    );

    const result = await service.proposeDue(NOW);

    expect(executor.proposed).toHaveLength(0);
    expect(result.proposed).toBe(0);
    expect(proposals.rows.get('p1')!.chainLastError).toBe('SLASH_BENEFICIARY_UNSUPPORTED');
  });
});

describe('the dispute upgrade (D-19)', () => {
  it('reads the live slash delay: a 10-minute chain defers a promise 71 hours out', async () => {
    // The 72 h floor is Solana's. An upgraded EVM Config may run a 10-minute
    // delay, and a record written now would open its door long before the
    // provider's promise.
    const { service, proposals, executor } = build();
    executor.slashDelay = 600;
    proposals.seed(proposable({ id: 'p1', earliestExecutionAt: hoursFromNow(71) }));

    expect(await service.proposeDue(NOW)).toEqual({ proposed: 0, refused: 0, failed: 0 });
    expect(executor.proposed).toEqual([]);

    proposals.rows.get('p1')!.earliestExecutionAt = new Date(NOW.getTime() + 9 * 60_000);
    expect(await service.proposeDue(NOW)).toEqual({ proposed: 1, refused: 0, failed: 0 });
  });

  it('returns a crashed EXECUTING case to UPHELD with a DISPUTED mirror', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(orphaned({ id: 'p1' }));
    const disputedAt = hoursFromNow(-1);
    executor.readRecordImpl = async () =>
      chainRecord({ status: 'DISPUTED', executedAt: null, disputedAt });

    expect(await service.reconcileExecuting(NOW)).toEqual({ recovered: 0, returned: 1, voided: 0 });
    expect(proposals.rows.get('p1')).toMatchObject({
      status: SlashProposalStatus.UPHELD,
      chainStatus: 'DISPUTED',
      chainDisputedAt: disputedAt,
    });
    // Out of the execute sweep until the arbiter's uphold lands.
    expect(await proposals.findChainExecutable(NOW, 100)).toEqual([]);
  });

  it('asks for the cancel of a closed case whose record is disputed', async () => {
    const { service, proposals } = build();
    proposals.seed(standing({ id: 'p1', chainStatus: 'DISPUTED' }));
    await expect(service.requestAdminCancel('org_1', 'p1', 'overturned')).resolves.toBe(true);
    expect(proposals.rows.get('p1')!.chainStatus).toBe('CANCEL_REQUESTED');
  });

  it('expires a cancel-requested DISPUTED record on disputedAt + 30 d, not on the grace', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(
      standingAndDue({
        id: 'p1',
        chainStatus: 'CANCEL_REQUESTED',
        chainExecutableAt: hoursFromNow(-8 * 24),
        chainDisputedAt: hoursFromNow(-29 * 24),
      }),
    );
    executor.readRecordImpl = async () =>
      chainRecord({ status: 'DISPUTED', executedAt: null, disputedAt: hoursFromNow(-29 * 24) });

    // The grace (executableAt + 7 d) has passed; the dispute clock has not.
    expect((await service.sweepAdminCancels(NOW)).expired).toBe(0);
    expect(executor.expired).toEqual([]);

    executor.readRecordImpl = async () =>
      chainRecord({ status: 'DISPUTED', executedAt: null, disputedAt: hoursFromNow(-30 * 24 - 1) });
    expect((await service.sweepAdminCancels(NOW)).expired).toBe(1);
  });

  it('AUDIT E-8: expires an upheld-then-cancel-requested record on executableAt + 7 d, not the dispute clock', async () => {
    const { service, proposals, executor } = build();
    // Disputed on day 0, upheld on day 1 (executable from then), overturned off chain.
    proposals.seed(
      standingAndDue({
        id: 'p1',
        chainStatus: 'CANCEL_REQUESTED',
        chainExecutableAt: hoursFromNow(-9 * 24),
        chainDisputedAt: hoursFromNow(-9 * 24),
      }),
    );
    executor.readRecordImpl = async () =>
      chainRecord({
        status: 'PENDING',
        executedAt: null,
        executableAt: hoursFromNow(-8 * 24),
        disputedAt: hoursFromNow(-9 * 24),
      });
    // Day 9: the dispute clock (day 30) has not run, the grace from day 1 has.
    expect((await service.sweepAdminCancels(NOW)).expired).toBe(1);
    expect(executor.expired).toHaveLength(1);
  });

  it('AUDIT E-8: does not try an upheld record before its new executableAt + 7 d', async () => {
    const { service, proposals, executor } = build();
    // Upheld on day 29 of the dispute: executable until day 36.
    proposals.seed(
      standingAndDue({
        id: 'p1',
        chainStatus: 'CANCEL_REQUESTED',
        chainExecutableAt: hoursFromNow(-40 * 24),
        chainDisputedAt: hoursFromNow(-31 * 24),
      }),
    );
    executor.readRecordImpl = async () =>
      chainRecord({
        status: 'PENDING',
        executedAt: null,
        executableAt: hoursFromNow(-2 * 24),
        disputedAt: hoursFromNow(-31 * 24),
      });
    expect((await service.sweepAdminCancels(NOW)).expired).toBe(0);
    expect(executor.expired).toEqual([]);
  });

  it('expires a disputed record nobody ruled on within 30 days and closes the case', async () => {
    const { service, proposals, executor } = build();
    proposals.seed(
      standingAndDue({
        id: 'p1',
        status: 'UPHELD',
        chainStatus: 'DISPUTED',
        chainDisputedAt: hoursFromNow(-30 * 24 - 1),
      }),
    );
    proposals.seed(
      standingAndDue({
        id: 'p2',
        status: 'UPHELD',
        chainStatus: 'DISPUTED',
        chainDisputedAt: hoursFromNow(-24),
      }),
    );
    executor.expireImpl = async () => ({
      signature: '0xexp',
      cancelledAt: NOW,
      reason: 'DISPUTE_UNRESOLVED',
    });

    expect(await service.sweepUnresolvedDisputes(NOW)).toEqual({ expired: 1 });
    expect(proposals.rows.get('p1')).toMatchObject({
      chainStatus: 'CANCELLED',
      status: SlashProposalStatus.CANCELLED,
    });
    expect(proposals.rows.get('p2')!.chainStatus).toBe('DISPUTED');
  });
});
