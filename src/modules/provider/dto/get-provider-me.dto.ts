import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ProviderStatus, ProviderTier } from '../ports/provider.types';

/**
 * `ProviderStats` on the wire.
 *
 * Every field optional, mirroring `ports/provider.types.ts` exactly: a
 * provider with no traffic has no rate, and serialising `0` for "not measured"
 * would starve it of the routing weight a real score would earn — see the
 * port's own comment. `null`/absent here, never `0`.
 */
export class ProviderStatsDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      '1 − SYSTEM_ERROR rate, rolling 24h. Shared across free and paid. `null` if unmeasured.',
  })
  availabilityRate: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'PASS / DATA_RESULT on PAID calls, rolling 7d. Tracked separately from `freeQualityRate` — ' +
      'never folded together. `null` if unmeasured.',
  })
  paidQualityRate: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'PASS / DATA_RESULT on FREE calls, rolling 7d. `null` if unmeasured.',
  })
  freeQualityRate: number | null;

  @ApiPropertyOptional({ nullable: true })
  p50LatencyMs: number | null;

  @ApiPropertyOptional({ nullable: true })
  p95LatencyMs: number | null;

  @ApiPropertyOptional({ nullable: true })
  callsServed: number | null;

  @ApiPropertyOptional({ nullable: true })
  upheldSlashes: number | null;
}

/**
 * `GET /providers/me` — the provider record for the calling organization.
 *
 * `id` is the calling organization's id — `providerId === organizationId`; see
 * `ProviderProfileService`'s class comment.
 */
export class GetProviderMeResponseDto {
  @ApiProperty({ description: "The provider's id — the calling organization's id" })
  id: string;

  @ApiProperty({ enum: ProviderStatus })
  status: ProviderStatus;

  @ApiProperty({ enum: ProviderTier })
  tier: ProviderTier;

  @ApiProperty({ type: ProviderStatsDto })
  stats: ProviderStatsDto;

  @ApiProperty({
    type: () => [ProviderSlashHoldDto],
    description:
      'The chains this provider is on a slash hold on: its paid bindings are not routed there ' +
      'while its penalties cannot be collected promptly. Empty when none. Lifts by itself once ' +
      'the condition clears on two consecutive checks.',
  })
  slashHolds: ProviderSlashHoldDto[];
}

/** One slash hold, for the provider console's banner. */
export class ProviderSlashHoldDto {
  @ApiProperty({ example: 'eip155:46630' })
  chainId: string;

  @ApiProperty({
    type: [String],
    enum: ['SLASH_WINDOW_FULL', 'STAKE_FULLY_RESERVED', 'BONDED_BELOW_MINIMUM'],
    description:
      'SLASH_WINDOW_FULL: the slash window is full and an upheld penalty waits to execute. ' +
      'STAKE_FULLY_RESERVED: pending penalties reserve all but less than one penalty of the ' +
      'stake. BONDED_BELOW_MINIMUM: bonded stake is below the minimum.',
  })
  reasons: string[];

  @ApiProperty({ type: String, format: 'date-time' })
  heldSince: string;
}
