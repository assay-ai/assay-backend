import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

/** Which row answered the lookup — the agent's own override, or the organization default. */
export enum SpendPolicyScope {
  ORGANIZATION = 'ORGANIZATION',
  AGENT = 'AGENT',
}

/**
 * Live usage, next to the ceilings on {@link SpendPolicyDto}. Two
 * sources, kept distinct rather than merged into one number:
 *
 * - `spendThisHour` / `spendToday` / `spendThisMonth` come from
 *   `payment_intents` (money held or settled — see `SpendUsageService`), the
 *   same read the spend/hour ceiling and the daily/monthly caps enforce
 *   against, so a voided or refunded call never shows here.
 * - `callsThisMinute` / `callsThisHour` come from the same Redis attempt
 *   counters `SpendPolicyEnforcementService`'s velocity check reads
 *   (see `SpendPolicyVelocityService.read`), so the number on this screen and
 *   the number a call was actually refused against can never disagree.
 */
export class SpendPolicyUsageDto {
  @ApiProperty({ type: MoneyDto })
  spendToday: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  spendThisMonth: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'Money held or settled since the top of the UTC hour. Read from payment_intents, so ' +
      'it does not depend on `usageReadable`; kept nullable for compatibility',
  })
  spendThisHour: MoneyDto | null;

  @ApiProperty({ nullable: true })
  callsThisMinute: number | null;

  @ApiProperty({ nullable: true })
  callsThisHour: number | null;

  @ApiProperty({
    description:
      'Same `chainReadable`-style escape hatch the capital screen uses: `false` means Redis ' +
      'could not be read, so `callsThisMinute`/`callsThisHour` are `null` rather than a wrong zero',
  })
  usageReadable: boolean;
}

export class SpendPolicyDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: SpendPolicyScope })
  scope: SpendPolicyScope;

  @ApiProperty({ nullable: true, description: '`null` when `scope` is `ORGANIZATION`' })
  agentId: string | null;

  @ApiProperty({
    description: 'Monotonic within this scope. What a receipt names as `spendPolicyVersion`',
  })
  policyVersion: number;

  @ApiProperty({ description: 'CAIP-19 asset id every limit below is denominated in' })
  asset: string;

  @ApiProperty()
  decimals: number;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: 'Largest single call. `null` = no ceiling',
  })
  perCallMax: MoneyDto | null;

  @ApiProperty({ type: MoneyDto, nullable: true })
  dailyCap: MoneyDto | null;

  @ApiProperty({ type: MoneyDto, nullable: true })
  monthlyCap: MoneyDto | null;

  @ApiProperty({ nullable: true, description: 'Velocity. `null` = unlimited rate' })
  maxCallsPerHour: number | null;

  @ApiProperty({
    nullable: true,
    description: 'The resolution a retry loop actually lives at. `null` = unlimited',
  })
  maxCallsPerMinute: number | null;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: 'Money per hour, the other half of velocity. `null` = unlimited',
  })
  maxSpendPerHour: MoneyDto | null;

  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      'Tool allowlist. `null` = every tool is allowed. `[]` = no tool is allowed — a stop ' +
      'distinct from pausing (see `paused`)',
  })
  allowedTools: string[] | null;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: 'Above this, the call elicits approval instead of spending',
  })
  requireApprovalAbove: MoneyDto | null;

  @ApiProperty({ description: 'The kill switch, distinct from a zeroed cap' })
  paused: boolean;

  @ApiProperty({ description: 'A user id, or `system` for a platform action' })
  changedBy: string;

  @ApiProperty({ nullable: true })
  changeReason: string | null;

  @ApiProperty({ description: 'ISO-8601 — when this version was written' })
  createdAt: string;

  @ApiPropertyOptional({
    type: SpendPolicyUsageDto,
    description:
      'Current consumption next to each ceiling. Omitted when it could not be ' +
      'computed (see `usageReadable`); never blocks the response',
  })
  usage?: SpendPolicyUsageDto;
}
