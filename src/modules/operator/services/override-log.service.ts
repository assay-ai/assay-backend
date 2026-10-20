import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import {
  ORGANIZATION_EPOCH_SCOPES,
  TenantEpochService,
} from '@shared/cache/redis-cache/tenant-epoch.service';

import { OverrideLogEntryEntity } from '@database/postgres/entities/override-log-entry.entity';
import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';

import {
  ApprovalMode,
  approverRolesSatisfy,
  lookupOverride,
  OperatorRole,
  OverrideDefinition,
  rolesSatisfy,
} from '../domain/override-register';
import { OperatorErrors } from '../errors/operator.errors';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';

/** Everything an entry needs that the caller knows and the register does not. */
export interface OverrideContext {
  /** The register code being exercised, e.g. `S-5`. */
  readonly code: string;
  readonly actor: OperatorSession;
  /**
   * The checker, on two-person rows: the operator who approved the queued
   * action (`OperatorApprovalService`). Its approval is marked `APPROVED` in
   * this action's transaction.
   */
  readonly approver?: OperatorApprover | null;
  readonly targetType: string;
  readonly targetId: string;
  /** The subject's tenant. `null` for platform-wide actions, and only those. */
  readonly organizationId: string | null;
  readonly reasonCode: string;
  readonly reason: string;
  readonly ticketRef?: string | null;
  readonly requestId?: string | null;
  /**
   * Raise an action to two-person for this occurrence only.
   *
   * A row whose register floor is `SINGLE` may need a second person for one
   * occurrence. The register cannot express that, because it is a property of
   * the case rather than of the action.
   */
  readonly escalateToTwoPerson?: boolean;
  /** Emergency single-actor execution. Recorded, reviewed, never silent. */
  readonly breakGlass?: boolean;
  /**
   * Money this action moves, in minor units, when it moves any.
   *
   * Checked against the actor's `authorityLimitMinor` — *"Authority is
   * bounded by a number, not by a role."* Without it, "support can issue a
   * credit" is an unbounded withdrawal authority on a custodial balance.
   */
  readonly amountMinor?: string | null;
}

/** What the mutation reports back, so the entry can state before and after. */
export interface OverrideResult<T> {
  readonly value: T;
  /** The relevant fields before — not the whole row. A diff nobody reads is no diff. */
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
}

/**
 * The one door every manual intervention goes through.
 *
 * ## The property this class exists to provide
 *
 * The requirement is *"every manual intervention appears in the
 * override register, with no way around it"*. That is an architectural claim, not a
 * testable behaviour of any one endpoint, so it is delivered by construction:
 *
 * 1. **The mutation and the entry share one transaction.** `perform` opens it,
 *    hands the caller a `QueryRunner`, writes the entry from the same runner
 *    and commits both or neither. There is no ordering in which one lands
 *    without the other, and no `catch` that can swallow the entry while keeping
 *    the change — a failure to write the entry rolls the mutation back.
 * 2. **The mutation cannot commit on its own.** Callers receive the runner and
 *    must use it; a service that opened its own connection would escape, which
 *    is why every arbitration write takes a `QueryRunner`
 *    parameter rather than reaching for a repository's default connection.
 * 3. **Every mutating operator route is required to declare a code.**
 *    `@Override()` supplies it and `OperatorOverrideGuard` refuses a
 *    non-`GET` handler that has none. A new endpoint that forgets is a 500 on
 *    its first call, not a silent gap in the register.
 * 4. **The register is append-only at the database.** Even a correct write
 *    path cannot later tidy what it wrote.
 *
 * The test that pins (3) enumerates the Nest route table rather than the
 * source, so a handler added in a file nobody thought to check is still caught.
 *
 * ## What this deliberately does not do
 *
 * It does not hold the approval *queue*. A two-person action called without
 * an approver is refused here with `OPERATOR_SECOND_APPROVER_REQUIRED`, and
 * `OperatorApprovalService` turns that refusal into a `PENDING` approval; when
 * a second operator approves it, the action runs again with them as the
 * approver, and this class checks their roles and limit and marks the approval
 * `APPROVED` inside the same transaction as the action — so an approval is
 * never spent on an action that rolled back, and two approvers racing produce
 * one execution.
 */
@Injectable()
export class OverrideLogService {
  private readonly logger = new Logger(OverrideLogService.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly entries: OverrideLogEntryRepository,
    private readonly approvals: OperatorApprovalRepository,
    @Optional() private readonly epochs?: TenantEpochService,
  ) {}

  /**
   * Run `mutation` and record it, atomically.
   *
   * The callback receives the transaction's `QueryRunner` and must do all of
   * its writing through it.
   */
  async perform<T>(
    context: OverrideContext,
    mutation: (queryRunner: QueryRunner) => Promise<OverrideResult<T>>,
  ): Promise<T> {
    const definition = this.assertPermitted(context);
    const approvalMode = this.approvalModeFor(definition, context);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (context.approver) {
        const claimed = await this.approvals.markApproved(
          queryRunner.manager,
          context.approver.approvalId,
          context.actor.operatorId,
          context.approver.operatorId,
        );
        if (!claimed) throw OperatorErrors.approvalNotPending({});
      }

      const result = await mutation(queryRunner);

      await this.entries.append(queryRunner, {
        organizationId: context.organizationId,
        family: definition.family,
        code: definition.code,
        action: definition.action,
        actorOperatorId: context.actor.operatorId,
        approverOperatorId: context.approver?.operatorId ?? null,
        approvalMode,
        targetType: context.targetType,
        targetId: context.targetId,
        reasonCode: context.reasonCode,
        reason: context.reason,
        before: result.before,
        after: result.after,
        ticketRef: context.ticketRef ?? null,
        breakGlass: approvalMode === ApprovalMode.BREAK_GLASS,
        requestId: context.requestId ?? null,
      });

      await queryRunner.commitTransaction();
      // Every operator mutation lands here: the console's cached lists, what
      // others see of shared state, and the target organization's own reads
      // miss from now on. A mutation that touches another organization
      // registers it with `bumpAfterCommit` on this transaction.
      await this.epochs?.bump(null, 'operator', 'shared');
      if (context.organizationId) {
        await this.epochs?.bump(context.organizationId, ...ORGANIZATION_EPOCH_SCOPES);
      }
      return result.value;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      // Logged at `error` even though it is rethrown: a rolled-back override is
      // the one failure mode where nothing is left behind to find later, so the
      // log line is the only trace that somebody tried.
      this.logger.error(
        `override ${context.code} by ${context.actor.subject} on ` +
          `${context.targetType}:${context.targetId} rolled back`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * The register row, if the actor may exercise it.
   *
   * Four refusals, in the order they cost the least to check.
   */
  private assertPermitted(context: OverrideContext): OverrideDefinition {
    const definition = lookupOverride(context.code);

    // An unknown code is a programming error, not a permission problem: the
    // register is a compile-time constant, so this can only mean a typo or a
    // route citing a row somebody deleted.
    if (!definition) {
      throw OperatorErrors.unknownOverrideCode({ code: context.code });
    }

    // A row the register enumerates but nothing has built yet. Refusing here rather
    // than letting it log is what keeps `implemented: false` honest — otherwise
    // the register would fill with entries for actions no code performs.
    if (!definition.implemented) {
      throw OperatorErrors.overrideNotImplemented({ code: context.code });
    }

    if (!rolesSatisfy(definition, context.actor.roles as OperatorRole[])) {
      throw OperatorErrors.roleRequired({
        code: context.code,
        required: definition.roles,
        held: context.actor.roles,
      });
    }

    this.assertWithinAuthority(context);
    return definition;
  }

  /**
   * The operator's authority limit.
   *
   * A null limit is unbounded, which is correct for roles whose actions move no
   * money — and an action that moves none passes regardless of the limit,
   * because comparing a limit against nothing would refuse an adjudicator with
   * a $0 ceiling from overturning a penalty, which costs the platform money and
   * takes none from anybody.
   */
  private assertWithinAuthority(context: OverrideContext): void {
    const limit = context.actor.authorityLimitMinor;
    if (limit === null || context.amountMinor === null || context.amountMinor === undefined) {
      return;
    }
    if (BigInt(context.amountMinor) > BigInt(limit)) {
      throw OperatorErrors.authorityExceeded({
        code: context.code,
        limit,
        requested: context.amountMinor,
      });
    }
  }

  /**
   * Which approval the register demands of this occurrence, and whether it was
   * supplied.
   *
   * Break-glass wins over everything, and is the only mode that reaches the
   * database with `break_glass = true`. It is not a way around two-person
   * review — it *moves* the audit from before the fact to
   * after it, and every use opens a review item that must be closed within one
   * business day. What makes that real is that the row is distinguishable
   * forever, which is what `chk_override_log_entries_break_glass_mode` is for.
   */
  private approvalModeFor(definition: OverrideDefinition, context: OverrideContext): ApprovalMode {
    if (context.breakGlass) {
      return ApprovalMode.BREAK_GLASS;
    }

    const required =
      definition.approval === ApprovalMode.TWO_PERSON || context.escalateToTwoPerson
        ? ApprovalMode.TWO_PERSON
        : definition.approval;

    if (required === ApprovalMode.TWO_PERSON) {
      if (!context.approver) {
        throw OperatorErrors.secondApproverRequired({ code: context.code });
      }
      if (context.approver.operatorId === context.actor.operatorId) {
        throw OperatorErrors.selfApprovalRefused({ code: context.code });
      }
      // The approver signed in with their own wallet and the guard found them
      // active; what is left to check is whether the row accepts their roles
      // as a checker's.
      if (!approverRolesSatisfy(definition, context.approver.roles as OperatorRole[])) {
        throw OperatorErrors.approverRoleRequired({
          code: context.code,
          required: definition.approverRoles,
          held: context.approver.roles,
        });
      }
      // The same ceiling the actor is held to, for the same reason: a checker
      // who could not have taken the action cannot approve it. Without this a
      // zero-authority token is enough to make any amount "two-person".
      const limit = context.approver.authorityLimitMinor;
      const amount = context.amountMinor;
      if (
        limit !== null &&
        amount !== null &&
        amount !== undefined &&
        BigInt(amount) > BigInt(limit)
      ) {
        throw OperatorErrors.approverAuthorityExceeded({
          code: context.code,
          limit,
          requested: amount,
        });
      }
    }

    return required;
  }

  /** The object's own history, for the case view's "what was done to this". */
  async historyFor(targetType: string, targetId: string): Promise<OverrideLogEntryEntity[]> {
    return this.entries.findByTarget(targetType, targetId);
  }
}
