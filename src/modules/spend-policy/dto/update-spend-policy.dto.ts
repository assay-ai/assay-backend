import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { SpendPolicyDto } from './get-spend-policy.dto';

/** Atomic units as a non-negative decimal integer string — same grammar as `MoneyDto.amount`. */
const ATOMIC_AMOUNT_RE = /^\d+$/;

/**
 * `PATCH /spend-policy` — writes a new version at the calling agent's scope
 * and supersedes the one it replaces (append-only, never an `UPDATE`).
 *
 * Every field is optional and independently omittable: an **omitted** key
 * keeps the previous version's value; an explicit JSON **`null`** clears a
 * limit (removes the ceiling). Both are meaningful, which is why these are
 * `T | null | undefined` rather than `T | undefined` — collapsing "not sent"
 * and "sent as null" would make it impossible to clear a cap through a PATCH
 * without resending every other field.
 *
 * `assetId` / `decimals` are required only when there is no existing policy at
 * this scope or the organization default to inherit them from — see
 * `SpendPolicyService.patch` and `SpendPolicyErrors.assetRequired`.
 */
export class UpdateSpendPolicyDto {
  @ApiPropertyOptional({
    description: 'CAIP-19. Required only when bootstrapping the first version',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  assetId?: string;

  @ApiPropertyOptional({ description: 'Required only when bootstrapping the first version' })
  @IsOptional()
  @IsInt()
  decimals?: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Atomic units. `null` removes the per-call ceiling',
  })
  @IsOptional()
  @Matches(ATOMIC_AMOUNT_RE)
  perCallMax?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Atomic units. `null` removes the daily cap',
  })
  @IsOptional()
  @Matches(ATOMIC_AMOUNT_RE)
  dailyCap?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Atomic units. `null` removes the monthly cap',
  })
  @IsOptional()
  @Matches(ATOMIC_AMOUNT_RE)
  monthlyCap?: string | null;

  @ApiPropertyOptional({ nullable: true, description: '`null` removes the velocity limit' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxCallsPerHour?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '`null` removes the per-minute velocity limit',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxCallsPerMinute?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Atomic units. `null` removes the spend-per-hour velocity limit',
  })
  @IsOptional()
  @Matches(ATOMIC_AMOUNT_RE)
  maxSpendPerHour?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Atomic units. `null` means every call spends without approval',
  })
  @IsOptional()
  @Matches(ATOMIC_AMOUNT_RE)
  requireApprovalAbove?: string | null;

  @ApiPropertyOptional({ description: 'Pause every paid call at this scope' })
  @IsOptional()
  @IsBoolean()
  paused?: boolean;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  changeReason?: string;

  /**
   * Ignored. Accepted so an older client that still sends it is not refused,
   * but the audit trail's actor comes from the authenticated session
   * (`agent:<agentId>`), never from the request body — a caller-chosen value
   * would let anyone write any name into the policy history.
   */
  @ApiPropertyOptional({
    maxLength: 128,
    deprecated: true,
    description: 'Ignored; set from the session.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  changedBy?: string;
}

export class UpdateSpendPolicyResponseDto extends SpendPolicyDto {}
