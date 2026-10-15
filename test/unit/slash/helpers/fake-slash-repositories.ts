import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlashProposalEventEntity } from '@database/postgres/entities/slash-proposal-event.entity';
import {
  ChainClaimGuards,
  ChainSweepRow,
  OverdueProposalRow,
  UndisputedProposalRow,
} from '@database/postgres/repositories/slash-proposal.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { NotificationRequest } from '@modules/notification/ports/notification.port';
import { CHAIN_DISPUTE_SETTLE_MS, SlashConfig } from '@modules/slash/constants/slash.constants';

/**
 * Hand-written fakes, matching `test/unit/provider/helpers/`.
 *
 * No `jest.mock` of a repository anywhere in this suite: a mocked class asserts
 * that a method was called, and what these tests need to assert is what the
 * *rows* end up saying. A fake that holds rows can answer that; a mock cannot.
 */
/**
 * Mirrors `CHAIN_PROPOSABLE_STATUSES` in
 * `slash-proposal.repository.ts`, name for name and order for order, so a
 * reader can check the two side by side.
 */
const CHAIN_PROPOSABLE_STATUSES = [
  'PROPOSED',
  'DISPUTED',
  'UNDER_REVIEW',
  'AWAITING_SECOND',
  'UPHELD',
] as const;

/** Mirrors `REVERSIBLE_STATUSES` in `slash-proposal.repository.ts`. */
const REVERSIBLE_STATUSES = ['EXECUTED', 'OVERTURNED'] as const;

export class FakeSlashProposals {
  /** The entity manager each `markReversedIfExecuted` ran on (undefined = default connection). */
  readonly reversalManagers: unknown[] = [];

  readonly rows = new Map<string, SlashProposalEntity>();

  /** Cases one of whose current records the arbiter upheld on chain (`arbiterUpheld`). */
  readonly arbiterUpheld = new Set<string>();

  /** Records every CAS attempt, so a test can prove which predicate refused. */
  readonly transitions: { id: string; from: readonly string[]; to: string; affected: number }[] =
    [];

  seed(
    proposal: Partial<SlashProposalEntity> & { id: string; organizationId: string },
  ): SlashProposalEntity {
    const row = Object.assign(
      new SlashProposalEntity(),
      {
        providerId: 'prv_1',
        bindingId: 'bnd_1',
        toolId: 'tool_1',
        source: 'SLA_STRIKE',
        strikeId: 'strike_1',
        verdictId: null,
        windowId: 'win_1',
        status: 'PROPOSED',
        chainRequestId: 'a'.repeat(64),
        // The eight `chain_*` columns, defaulted to exactly what
        // `1759000000000-slash-proposals-two-phase-chain.ts` gives a freshly
        // inserted row: `chain_status NOT NULL DEFAULT 'NONE'`, `chain_epoch
        // NOT NULL DEFAULT 0`, and six nullable columns that start null.
        //
        // Without these a seeded row that does not mention `chainStatus` holds
        // `undefined`, which no database row can ever hold — and a sweep
        // predicate reading `row.chainStatus === 'NONE'` would then quietly
        // skip a row Postgres would have returned. The fake carries no
        // constraints; it can at least carry the defaults.
        chainStatus: 'NONE',
        chainEpoch: 0,
        chainProposedAt: null,
        chainExecutableAt: null,
        chainReserved: null,
        chainProposalSignature: null,
        chainClaimedAt: null,
        chainLastError: null,
        chainDisputedAt: null,
        penaltyAmount: '5000000',
        appliedAmount: null,
        // A real CAIP-19: `MoneyUtil.of` refuses anything else, and the
        // compensation path builds a `Money` out of this column.
        assetId: ASSET_IDS.USDC_SOLANA_DEVNET,
        decimals: 6,
        beneficiaryAccount: 'agent_1',
        proposedAt: new Date('2026-08-10T09:14:00Z'),
        notifiedAt: new Date('2026-08-10T09:14:00Z'),
        acknowledgedAt: null,
        respondByAt: new Date('2026-08-12T09:14:00Z'),
        platformDecisionDueAt: null,
        earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
        disputedAt: null,
        disputeId: null,
        resolutionKind: null,
        outcome: null,
        resolvedAt: null,
        decidedByOperatorId: null,
        secondedByOperatorId: null,
        secondedAt: null,
        secondKind: null,
        executedAt: null,
        executionSignature: null,
        reversedAt: null,
        reversalSignature: null,
        rootCauseKey: null,
        sweepId: null,
        countsAsFalsePositive: false,
        createdAt: new Date('2026-08-10T09:14:00Z'),
        updatedAt: new Date('2026-08-10T09:14:00Z'),
        version: 1,
      },
      proposal,
    );
    this.rows.set(row.id, row);
    return row;
  }

  async findOneBy(where: {
    organizationId: string;
    id?: string;
    strikeId?: string;
    verdictId?: string;
    windowId?: string;
    /** Any value here stands for TypeORM's `Not(IsNull())`, the only use. */
    chainDisputeWonAt?: unknown;
  }) {
    for (const row of this.rows.values()) {
      if (row.organizationId !== where.organizationId) continue;
      if (where.id !== undefined && row.id !== where.id) continue;
      if (where.strikeId !== undefined && row.strikeId !== where.strikeId) continue;
      if (where.verdictId !== undefined && row.verdictId !== where.verdictId) continue;
      if (where.windowId !== undefined && row.windowId !== where.windowId) continue;
      if (where.chainDisputeWonAt !== undefined && !row.chainDisputeWonAt) continue;
      return row;
    }
    return null;
  }

  async findOneScoped(organizationId: string, id: string) {
    return this.findOneBy({ organizationId, id });
  }

  async save(row: SlashProposalEntity) {
    this.rows.set(row.id, row);
    return row;
  }

  /**
   * The compare-and-swap, faked with the same semantics as the real one:
   * zero affected rows when the status is not one the caller expected.
   */
  async transitionIfIn(
    organizationId: string,
    id: string,
    expectedFrom: readonly string[],
    patch: Partial<SlashProposalEntity> & { status: string },
  ): Promise<number> {
    const row = this.rows.get(id);
    const affected =
      row && row.organizationId === organizationId && expectedFrom.includes(row.status) ? 1 : 0;
    this.transitions.push({ id, from: expectedFrom, to: patch.status, affected });
    if (affected === 1 && row) Object.assign(row, patch);
    return affected;
  }

  /**
   * Mirrors `SlashProposalRepository.markReversedIfExecuted`, predicate for
   * predicate. The money columns are what decide it — a case the chain executed
   * after an adjudicator overturned it carries them in `OVERTURNED` — and the
   * status list is the state-machine half beside them, matching the `→
   * REVERSED` column of `SLASH_PROPOSAL_TRANSITIONS`.
   */
  async markReversedIfExecuted(
    organizationId: string,
    id: string,
    reversedAt: Date,
    reversalSignature: string,
    manager?: unknown,
  ): Promise<number> {
    this.reversalManagers.push(manager);
    const row = this.rows.get(id);
    if (
      !row ||
      row.organizationId !== organizationId ||
      !REVERSIBLE_STATUSES.includes(row.status as (typeof REVERSIBLE_STATUSES)[number]) ||
      row.executedAt === null ||
      row.appliedAmount === null ||
      row.reversedAt !== null
    ) {
      return 0;
    }
    Object.assign(row, { status: 'REVERSED', reversedAt, reversalSignature });
    return 1;
  }

  async markNotifiedIfUnnotified(
    organizationId: string,
    id: string,
    notifiedAt: Date,
    respondByAt: Date | null,
  ): Promise<number> {
    const row = this.rows.get(id);
    if (!row || row.organizationId !== organizationId || row.notifiedAt !== null) return 0;
    Object.assign(row, { notifiedAt, respondByAt });
    return 1;
  }

  async findUndisputedPast(now: Date, limit: number): Promise<UndisputedProposalRow[]> {
    return [...this.rows.values()]
      .map((row) => ({
        row,
        deadline: row.assetId.startsWith('eip155:')
          ? row.chainStatus === 'PENDING'
            ? row.chainExecutableAt
            : null
          : row.respondByAt,
      }))
      .filter(
        ({ row, deadline }) =>
          row.status === 'PROPOSED' &&
          deadline &&
          // As the real query: an EVM door counts once the settle margin passed.
          deadline.getTime() +
            (row.assetId.startsWith('eip155:') ? CHAIN_DISPUTE_SETTLE_MS : 0) <=
            now.getTime(),
      )
      .slice(0, limit)
      .map(({ row, deadline }) => ({
        organizationId: row.organizationId,
        id: row.id,
        respondByAt: deadline as Date,
        arbiterUpheld: this.arbiterUpheld.has(row.id),
      }));
  }

  async findOverduePast(now: Date, limit: number): Promise<OverdueProposalRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          ['DISPUTED', 'UNDER_REVIEW'].includes(row.status) &&
          !row.assetId.startsWith('eip155:') &&
          row.platformDecisionDueAt &&
          row.platformDecisionDueAt <= now,
      )
      .slice(0, limit)
      .map((row) => ({
        organizationId: row.organizationId,
        id: row.id,
        disputeId: row.disputeId,
        platformDecisionDueAt: row.platformDecisionDueAt as Date,
      }));
  }

  /** Mirrors `SlashProposalRepository.findAwaitingChainProposal` — see that method's SQL. */
  async findAwaitingChainProposal(
    _now: Date,
    staleClaimBefore: Date,
    limit: number,
  ): Promise<ChainSweepRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          (CHAIN_PROPOSABLE_STATUSES as readonly string[]).includes(row.status) &&
          row.notifiedAt !== null &&
          (row.chainStatus === 'NONE' ||
            (row.chainStatus === 'PROPOSING' &&
              row.chainClaimedAt !== null &&
              row.chainClaimedAt <= staleClaimBefore)),
      )
      .sort((a, b) => a.proposedAt.getTime() - b.proposedAt.getTime())
      .slice(0, limit)
      .map((row) => ({ organizationId: row.organizationId, id: row.id }));
  }

  /** Mirrors `SlashProposalRepository.findChainExecutable` — see that method's SQL. */
  async findChainExecutable(now: Date, limit: number): Promise<ChainSweepRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.status === 'UPHELD' &&
          row.chainStatus === 'PENDING' &&
          row.chainExecutableAt !== null &&
          row.chainExecutableAt <= now &&
          row.earliestExecutionAt <= now,
      )
      .sort(
        (a, b) => (a.chainExecutableAt as Date).getTime() - (b.chainExecutableAt as Date).getTime(),
      )
      .slice(0, limit)
      .map((row) => ({ organizationId: row.organizationId, id: row.id }));
  }

  /** Mirrors `SlashProposalRepository.findAwaitingAdminCancel` — see that method's SQL. */
  async findAwaitingAdminCancel(limit: number): Promise<ChainSweepRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.chainStatus === 'CANCEL_REQUESTED')
      .sort((a, b) => (a.chainExecutableAt?.getTime() ?? 0) - (b.chainExecutableAt?.getTime() ?? 0))
      .slice(0, limit)
      .map((row) => ({ organizationId: row.organizationId, id: row.id }));
  }

  /** Mirrors `SlashProposalRepository.findChainDisputedBefore`. */
  async findChainDisputedBefore(disputedBefore: Date, limit: number): Promise<ChainSweepRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.chainStatus === 'DISPUTED' &&
          row.chainDisputedAt !== null &&
          row.chainDisputedAt.getTime() <= disputedBefore.getTime(),
      )
      .slice(0, limit)
      .map((row) => ({ organizationId: row.organizationId, id: row.id }));
  }

  /** Mirrors `SlashProposalRepository.findStandingPastDoor` — see that method's SQL. */
  async findStandingPastDoor(now: Date, limit: number): Promise<ChainSweepRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          ['PENDING', 'DISPUTED'].includes(row.chainStatus) &&
          row.chainExecutableAt !== null &&
          row.chainExecutableAt.getTime() <= now.getTime() &&
          row.executedAt === null &&
          row.status !== 'EXECUTING',
      )
      .sort((a, b) => (a.chainExecutableAt?.getTime() ?? 0) - (b.chainExecutableAt?.getTime() ?? 0))
      .slice(0, limit)
      .map((row) => ({ organizationId: row.organizationId, id: row.id }));
  }

  /** Mirrors `SlashProposalRepository.findClosedStillPending` — see that method's SQL. */
  async findClosedStillPending(limit: number): Promise<ChainSweepRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          ['PENDING', 'DISPUTED'].includes(row.chainStatus) &&
          ['CANCELLED', 'OVERTURNED'].includes(row.status) &&
          row.resolutionKind !== 'AUTO_CHAIN_VOIDED',
      )
      .sort((a, b) => (a.chainExecutableAt?.getTime() ?? 0) - (b.chainExecutableAt?.getTime() ?? 0))
      .slice(0, limit)
      .map((row) => ({ organizationId: row.organizationId, id: row.id }));
  }

  /** Mirrors `SlashProposalRepository.findExecutingToReconcile` — see that method's SQL. */
  async findExecutingToReconcile(staleClaimBefore: Date, limit: number): Promise<ChainSweepRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          (row.chainClaimedAt === null || row.chainClaimedAt <= staleClaimBefore) &&
          // Two shapes: an orphaned `EXECUTING` claim, and the adopted-EXECUTED
          // park — a row the chain says was paid and that carries no execution.
          (row.status === 'EXECUTING' ||
            (row.chainStatus === 'EXECUTED' && row.executedAt === null)),
      )
      .sort((a, b) => {
        const aTime = a.chainClaimedAt?.getTime() ?? 0;
        const bTime = b.chainClaimedAt?.getTime() ?? 0;
        return aTime - bTime;
      })
      .slice(0, limit)
      .map((row) => ({ organizationId: row.organizationId, id: row.id }));
  }

  /**
   * Mirrors `SlashProposalRepository.findSweepCandidates` — see that method's
   * query builder. Terminal cases are excluded except `EXECUTED`, which is
   * precisely the one a sweep must reach.
   */
  async findSweepCandidates(
    defectKey: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<
    Array<{
      organizationId: string;
      id: string;
      status: string;
      penaltyAmount: string;
      disputeId: string | null;
    }>
  > {
    return [...this.rows.values()]
      .filter(
        (row) =>
          !['OVERTURNED', 'REVERSED', 'WAIVED', 'CANCELLED'].includes(row.status) &&
          !String(row.assetId).startsWith('eip155:') &&
          row.rootCauseKey === defectKey &&
          row.proposedAt >= from &&
          row.proposedAt <= to,
      )
      .sort((a, b) => a.proposedAt.getTime() - b.proposedAt.getTime())
      .slice(0, limit)
      .map((row) => ({
        organizationId: row.organizationId,
        id: row.id,
        status: row.status,
        penaltyAmount: row.penaltyAmount,
        disputeId: row.disputeId,
      }));
  }

  /**
   * The chain-mirror CAS, faked with the same semantics as the real one: zero
   * affected rows when any of its predicates refuses.
   *
   * Mirrors `SlashProposalRepository.claimChainStatus` predicate for
   * predicate, including both optional guards — `staleClaimBefore` (a row
   * already at the target may only be re-claimed once its own claim has gone
   * stale, which is what stops two sweeps both winning a `PROPOSING` row) and
   * `caseStatusIn` (the case must not have gone terminal since the SELECT).
   */
  async claimChainStatus(
    organizationId: string,
    id: string,
    expectedFrom: readonly string[],
    to: string,
    claimedAt: Date,
    guards: ChainClaimGuards = {},
  ): Promise<number> {
    const row = this.rows.get(id);
    if (!row || row.organizationId !== organizationId) return 0;
    if (!expectedFrom.includes(row.chainStatus)) return 0;
    if (
      guards.staleClaimBefore &&
      row.chainStatus === to &&
      !(row.chainClaimedAt !== null && row.chainClaimedAt <= guards.staleClaimBefore)
    ) {
      return 0;
    }
    if (guards.caseStatusIn && !guards.caseStatusIn.includes(row.status)) return 0;

    Object.assign(row, { chainStatus: to, chainClaimedAt: claimedAt });
    return 1;
  }

  /**
   * A plain patch, scoped by `organizationId` and `id` — the shape
   * `SlashProposalRepository`'s inherited `update()` is called with
   * throughout this suite (see `FakeVerificationRecords.update` for the same
   * pattern one domain over). Not a CAS: it does not check `status` or
   * `chain_status` first, because Tasks 8/9/10 use it only after a CAS
   * (`transitionIfIn` / `claimChainStatus`) has already won the row.
   */
  async update(
    criteria: {
      readonly organizationId: string;
      readonly id: string;
      /** A compare-and-set on the epoch, as the real `WHERE` would apply it. */
      readonly chainEpoch?: number;
    },
    patch: Partial<SlashProposalEntity>,
  ): Promise<{ affected: number }> {
    const row = this.rows.get(criteria.id);
    if (!row || row.organizationId !== criteria.organizationId) return { affected: 0 };
    if (criteria.chainEpoch !== undefined && row.chainEpoch !== criteria.chainEpoch) {
      return { affected: 0 };
    }
    Object.assign(row, patch);
    return { affected: 1 };
  }
}

export class FakeSlashEvents {
  readonly rows: Partial<SlashProposalEventEntity>[] = [];

  async append(entry: Partial<SlashProposalEventEntity>): Promise<void> {
    this.rows.push(entry);
  }

  kinds(): string[] {
    return this.rows.map((row) => row.kind as string);
  }
}

export class FakeNotifications {
  readonly sent: NotificationRequest[] = [];

  /**
   * Reports a synchronous delivery, as the real service does for
   * `IN_APP`: it is marked `DELIVERED` at insert and never queued, so a caller
   * that starts a clock on delivery starts it here.
   */
  async notify(request: NotificationRequest): Promise<{ deliveredNow: boolean }> {
    this.sent.push(request);
    return { deliveredNow: true };
  }
}

export const TEST_SLASH_CONFIG: SlashConfig = {
  timelockMs: 72 * 60 * 60 * 1000,
  responseWindowMs: 48 * 60 * 60 * 1000,
  // 23 + the 1h guard band, matching the shipped defaults: the fixture has to
  // satisfy the same boot invariant `loadSlashConfig` asserts, or the tests run
  // against a combination the application refuses to start on.
  platformDecisionWindowMs: 23 * 60 * 60 * 1000,
  executionGuardMs: 1 * 60 * 60 * 1000,
  deMinimisMinor: '0',
  secondSignatureThresholdMinor: '2500000',
  sweepBatchSize: 100,
  assetDecimals: 6,
};
