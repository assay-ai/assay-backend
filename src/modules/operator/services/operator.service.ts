import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OperatorEntity } from '@database/postgres/entities/operator.entity';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { platformAssetFrom } from '@modules/chains/platform-asset';

import { OperatorDto } from '../dto/operator-console.dto';
import { OperatorRole } from '../domain/override-register';
import { OperatorErrors } from '../errors/operator.errors';
import { OperatorSession } from '../ports/operator-session.port';

/**
 * The platform asset `authority_limit_minor` is denominated in.
 *
 * `operators` stores a bare `numeric(78,0)` with no sibling `asset_id`
 * column — unlike `slash_proposals.penalty_amount`, which carries one on the
 * same row. That is consistent with `PayoutThresholdParameters` and
 * `MinimumStakeParameters`: both read `PLATFORM_STAKE_ASSET_ID` rather than
 * their own env var, on the stated reasoning that "the MVP has one payout
 * asset". Authority is spent against that same balance, so it reads the same
 * variable rather than inventing a second one that would need to be kept in
 * sync with it by convention alone.
 */
function platformAsset(config: ConfigService): {
  readonly asset: AssetId;
  readonly decimals: number;
} {
  const asset = platformAssetFrom(config);
  return { asset, decimals: 6 };
}

/**
 * The operator directory's own small service — identity, not arbitration.
 *
 * Everything that decides a case, opens a sweep or writes an override log
 * entry is the orchestrator's (`OverrideLogService` and friends). This
 * service answers three questions those flows all need answered the same
 * way: how an `OperatorEntity` renders on the wire, whether an operator named
 * by id is still allowed to act, and whether two named operators are actually
 * two people.
 */
/** How long a resolved operator row is reused before it is read again. */
export const OPERATOR_ROW_CACHE_MS = 5_000;

@Injectable()
export class OperatorService {
  private readonly asset: { readonly asset: AssetId; readonly decimals: number };

  /**
   * Active operator rows by id, for a few seconds. Every request re-checks
   * the row, and this keeps that from being a query per request. A change made
   * through the console invalidates this instance's entry at once and revokes
   * the operator's sessions where it removes access, so another instance's
   * stale entry can only lag a role change, by at most this long.
   */
  private readonly cache = new Map<string, { entity: OperatorEntity; at: number }>();

  constructor(
    private readonly operators: OperatorRepository,
    config: ConfigService,
  ) {
    this.asset = platformAsset(config);
  }

  /** Who is holding the token, as the console renders them (`OperatorDto`). */
  toDto(entity: OperatorEntity): OperatorDto {
    return {
      id: entity.id,
      subject: entity.subject,
      displayName: entity.displayName,
      roles: entity.roles as OperatorRole[],
      authorityLimit:
        entity.authorityLimitMinor === null
          ? null
          : {
              amount: entity.authorityLimitMinor,
              asset: this.asset.asset,
              decimals: this.asset.decimals,
            },
      walletAddress: entity.walletAddress,
      status: entity.status as 'ACTIVE' | 'SUSPENDED' | 'REMOVED',
    };
  }

  /** The session shape of a row, for the guard and for re-running a queued action. */
  sessionOf(entity: OperatorEntity): OperatorSession {
    return {
      operatorId: entity.id,
      subject: entity.subject,
      displayName: entity.displayName,
      email: entity.email,
      walletAddress: entity.walletAddress,
      roles: entity.roles as OperatorRole[],
      authorityLimitMinor: entity.authorityLimitMinor,
    };
  }

  /** The active row for `id`, from the short cache, or `null` when it is not active. */
  async findActiveCached(id: string): Promise<OperatorEntity | null> {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < OPERATOR_ROW_CACHE_MS) return hit.entity;

    const entity = await this.operators.findById(id);
    if (!entity || entity.status !== 'ACTIVE') {
      this.cache.delete(id);
      return null;
    }
    this.cache.set(id, { entity, at: Date.now() });
    return entity;
  }

  /** Drop this instance's cached row for `id`. Called on every change to it. */
  invalidate(id: string): void {
    this.cache.delete(id);
  }

  /**
   * Looks an operator up by id and refuses unless they may still act.
   *
   * The caller for this is every place an id is about to become an
   * `approver_operator_id`, `assigned_operator_id` or `opened_by_operator_id`
   * — an id that resolved to an active operator
   * five minutes ago is not proof it still does, and the revocation story
   * is worthless if only the sign-in path checks `status`. Uncached.
   */
  async requireActive(id: string): Promise<OperatorEntity> {
    const operator = await this.operators.findById(id);
    if (!operator) {
      throw OperatorErrors.notFound({ id });
    }
    if (operator.status !== 'ACTIVE') {
      throw OperatorErrors.notAuthorized();
    }
    return operator;
  }
}
