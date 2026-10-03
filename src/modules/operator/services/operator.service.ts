import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OperatorEntity } from '@database/postgres/entities/operator.entity';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { platformAssetFrom } from '@modules/chains/platform-asset';

import { OperatorDto } from '../dto/operator-console.dto';
import { OperatorRole } from '../domain/override-register';
import { OperatorErrors } from '../errors/operator.errors';

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
@Injectable()
export class OperatorService {
  private readonly asset: { readonly asset: AssetId; readonly decimals: number };

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
      status: entity.status as 'ACTIVE' | 'SUSPENDED',
    };
  }

  /**
   * Looks an operator up by id and refuses unless they may still act.
   *
   * The caller for this is every place an id is about to become a
   * `decided_by_operator_id`, `approver_operator_id`, `assigned_operator_id`
   * or `opened_by_operator_id` — an id that resolved to an active operator
   * five minutes ago is not proof it still does, and the revocation story
   * is worthless if only the bearer-token path checks `status`.
   */
  async requireActive(id: string): Promise<OperatorEntity> {
    const operator = await this.operators.findById(id);
    if (!operator) {
      throw OperatorErrors.notFound({ id });
    }
    if (operator.status === 'SUSPENDED') {
      throw OperatorErrors.suspended({ subject: operator.subject });
    }
    return operator;
  }

  /**
   * "No self-approval, enforced in code" — the code half of the pair
   * `chk_override_log_entries_no_self_approval` also enforces at the row.
   * Refuses even before either operator is looked up: two identical ids can
   * never be two people, regardless of what either one's row says.
   */
  assertDifferentPerson(actorOperatorId: string, approverOperatorId: string): void {
    if (actorOperatorId === approverOperatorId) {
      throw OperatorErrors.selfApprovalRefused();
    }
  }
}
