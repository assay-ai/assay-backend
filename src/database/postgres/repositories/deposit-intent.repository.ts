import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { DepositIntentEntity } from '../entities/deposit-intent.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** A deposit intent the expiry sweep has work to do on. Mirrors `DuePaymentIntent`. */
export interface DueDepositIntent {
  readonly organizationId: string;
  readonly id: string;
  readonly status: string;
}

@Injectable()
export class DepositIntentRepository extends OrganizationScopedRepository<DepositIntentEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(DepositIntentEntity, dataSource);
  }

  /**
   * Moves a deposit intent from one status to another, conditionally.
   *
   * Same compare-and-swap reasoning as `PaymentIntentRepository`'s — the
   * `status = from` predicate is what makes a concurrent `settleDeposit` call
   * lose cleanly instead of crediting the ledger twice.
   */
  async transitionIfInStatus(
    organizationId: string,
    intentId: string,
    from: string,
    to: string,
    patch: QueryDeepPartialEntity<DepositIntentEntity>,
  ): Promise<number> {
    const result = await this.update(
      { organizationId, id: intentId, status: from },
      { ...patch, status: to },
    );

    return result.affected ?? 0;
  }

  /**
   * Deposit intents whose deadline has passed while still `CREATED`.
   *
   * Deliberately cross-tenant, same reasoning as
   * `PaymentIntentRepository.findDueForExpiry` — the sweep is a platform job
   * with no calling tenant.
   */
  async findDueForExpiry(now: Date, limit: number): Promise<DueDepositIntent[]> {
    return this.selectSweepCandidates()
      .where('intent.status = :status', { status: 'CREATED' })
      .andWhere('intent.expiresAt < :now', { now })
      .orderBy('intent.expiresAt', 'ASC')
      .limit(limit)
      .getRawMany<DueDepositIntent>();
  }

  /**
   * Which of these deposit transaction hashes a deposit intent credited or is
   * crediting (`SETTLING` / `SETTLED`). For the reconciler (A2): a `Deposited`
   * event whose hash is not here was never credited. Plain equality on the
   * column so `idx_deposit_intents_chain_tx_ref` serves it: the settle path
   * stores the chain adapter's hash, lower-case hex, and the inputs are
   * lower-cased to match. Deliberately cross-tenant: the escrow walk is a
   * platform job.
   */
  async findCreditedTxRefs(account: string, txRefs: readonly string[]): Promise<Set<string>> {
    if (txRefs.length === 0) return new Set();
    // Per account: one transaction can fund several buyers, and each buyer's
    // share is claimed on its own (see `findClaimOfTxRef`).
    const rows = (await this.manager.query(
      `SELECT DISTINCT "chain_tx_ref" AS "ref"
         FROM "deposit_intents"
        WHERE "status" IN ('SETTLING', 'SETTLED')
          AND "agent_account" = $1
          AND "chain_tx_ref" = ANY($2)`,
      [account, txRefs.map((ref) => ref.toLowerCase())],
    )) as { ref: string }[];
    return new Set(rows.map((row) => row.ref));
  }

  /**
   * The deposit intent that already credited `account` from this transaction,
   * in ANY organization, or the bare fact that a deposit ledger entry did
   * (`intentId: null` for a credit with no intent row).
   *
   * The claim unit is the pair (transaction, buyer account): a batch
   * transaction that funds two buyers lets each claim only its own events,
   * once. Only a SUCCESSFUL credit is found here — `chain_tx_ref` is written on
   * an intent only with its settled amount, and a ledger entry only when
   * the credit is written — so a failed, refused or retried claim never
   * reserves a hash someone else can then not use. Cross-tenant on purpose:
   * single use is a global property (the unique indexes are global too).
   */
  async findClaimOfTxRef(
    txRef: string,
    account: string,
  ): Promise<{ readonly intentId: string | null } | null> {
    // One arm per entry type, each matching a partial index's predicate
    // exactly (`uq_ledger_entries_deposit_pending_account`,
    // `idx_ledger_entries_deposit_legacy_account`). An `IN (...)` over both
    // types matched neither and read every ledger row of the account.
    const rows = (await this.manager.query(
      `(SELECT "id"::text AS "intentId"
          FROM "deposit_intents"
         WHERE "chain_tx_ref" = $1 AND "agent_account" = $2
         LIMIT 1)
       UNION ALL
       (SELECT "intent_id"::text AS "intentId"
          FROM "ledger_entries"
         WHERE "chain_tx_ref" = $1 AND "account_id" = $2
           AND "entry_type" = 'DEPOSIT_PENDING' AND "chain_tx_ref" IS NOT NULL
         LIMIT 1)
       UNION ALL
       (SELECT "intent_id"::text AS "intentId"
          FROM "ledger_entries"
         WHERE "chain_tx_ref" = $1 AND "account_id" = $2
           AND "entry_type" = 'DEPOSIT' AND "chain_tx_ref" IS NOT NULL
         LIMIT 1)
       LIMIT 1`,
      [txRef, account],
    )) as { intentId: string | null }[];
    return rows.length > 0 ? { intentId: rows[0].intentId ?? null } : null;
  }

  /**
   * How many deposits this agent has open: `CREATED` or `SETTLING`, still
   * inside the intent's lifetime. An expired `CREATED` row waiting for the
   * sweep, and a `SETTLING` row older than its lifetime (stuck, resumed by the
   * finality job), no longer count. The abuse cap on `POST /deposits`.
   */
  async countOpenForAgent(organizationId: string, agentId: string, now: Date): Promise<number> {
    return this.createQueryBuilder('intent')
      .where('intent.organizationId = :organizationId', { organizationId })
      .andWhere('intent.agentId = :agentId', { agentId })
      .andWhere("intent.status IN ('CREATED', 'SETTLING')")
      .andWhere('intent.expiresAt > :now', { now })
      .getCount();
  }

  /**
   * When the earliest deposit intent of this buyer account that never settled
   * (`CREATED`, `EXPIRED`, `FAILED`) was created, among those created at or
   * after `since`. The broadcast time bound: a transaction mined inside any
   * such intent's life is a deposit made through an intent. Cross-tenant on
   * the account, like the claim lookup (an account belongs to one
   * organization's escrow anyway). Served by `idx_deposit_intents_account_created`.
   */
  async earliestUnsettledCreatedAt(account: string, since: Date): Promise<Date | null> {
    const rows = (await this.manager.query(
      `SELECT min("created_at") AS "at"
         FROM "deposit_intents"
        WHERE "agent_account" = $1
          AND "created_at" >= $2
          AND "status" IN ('CREATED', 'EXPIRED', 'FAILED')`,
      [account, since],
    )) as { at: Date | string | null }[];
    const at = rows[0]?.at ?? null;
    return at === null ? null : new Date(at);
  }

  /**
   * `SETTLING` intents not touched since `before`: no live request owns them
   * any more. Cross-tenant, for the finality job.
   */
  async findStaleSettling(before: Date, limit: number): Promise<DepositIntentEntity[]> {
    return this.createQueryBuilder('intent')
      .where('intent.status = :status', { status: 'SETTLING' })
      .andWhere('intent.updatedAt < :before', { before })
      .orderBy('intent.updatedAt', 'ASC')
      .limit(limit)
      .getMany();
  }

  /** Records the transaction a `SETTLING` intent is settling on. */
  async recordSubmittedTx(
    organizationId: string,
    intentId: string,
    txRef: string,
  ): Promise<number> {
    const result = await this.update(
      { organizationId, id: intentId, status: 'SETTLING' },
      { submittedTxRef: txRef },
    );
    return result.affected ?? 0;
  }

  /**
   * `SETTLED` deposits with a transaction to re-check for finality.
   *
   * The ledger journal remains the source of truth for whether a promotion
   * already happened — `DepositFinalityService` reads it per candidate and
   * that check is what makes a second `DEPOSIT_CONFIRM` impossible.
   * `finality_resolved_at IS NULL` is only the **queue predicate**: it decides
   * what is worth looking at, never what happened.
   *
   * That predicate is not optional. Without it nothing ever left this set —
   * the sweep writes ledger entries and never touches the row, and
   * `updated_at` moves only on a real `UPDATE` — so the 200 oldest settled
   * deposits became a permanent prefix and every deposit settled after the
   * two-hundredth was never promoted. `DepositFinalityResolution1758100000001`
   * carries the full account, including why a stale marker can only cost a
   * redundant journal read.
   *
   * Deliberately cross-tenant, same reasoning as `findDueForExpiry`.
   */
  async findSettledAwaitingFinality(limit: number): Promise<SettledDepositIntent[]> {
    return this.createQueryBuilder('intent')
      .select('intent.organizationId', 'organizationId')
      .addSelect('intent.id', 'id')
      .addSelect('intent.chainId', 'chainId')
      .addSelect('intent.chainTxRef', 'chainTxRef')
      .where('intent.status = :status', { status: 'SETTLED' })
      .andWhere('intent.chainTxRef IS NOT NULL')
      .andWhere('intent.finalityResolvedAt IS NULL')
      .orderBy('intent.updatedAt', 'ASC')
      .limit(limit)
      .getRawMany<SettledDepositIntent>();
  }

  /**
   * Takes a deposit out of the finality queue.
   *
   * Called *after* the resolving ledger entry is durable, never before: a
   * crash between the two costs one extra journal read on the next pass,
   * whereas the reverse order would strand the deposit exactly as the missing
   * predicate used to.
   *
   * Idempotent — the timestamp is only ever read as "is this null", so
   * re-stamping an already-stamped row changes nothing the sweep can observe.
   */
  async markFinalityResolved(
    organizationId: string,
    intentId: string,
    resolvedAt: Date,
  ): Promise<number> {
    const result = await this.update(
      { organizationId, id: intentId },
      { finalityResolvedAt: resolvedAt },
    );

    return result.affected ?? 0;
  }

  private selectSweepCandidates(): SelectQueryBuilder<DepositIntentEntity> {
    return this.createQueryBuilder('intent')
      .select('intent.organizationId', 'organizationId')
      .addSelect('intent.id', 'id')
      .addSelect('intent.status', 'status');
  }
}

export interface SettledDepositIntent {
  readonly organizationId: string;
  readonly id: string;
  readonly chainId: string;
  readonly chainTxRef: string;
}
