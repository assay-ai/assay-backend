import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export type AnalyticsRange = '7d' | '30d' | '90d' | 'all';

export class ProtocolAnalyticsQueryDto {
  @ApiPropertyOptional({ enum: ['7d', '30d', '90d', 'all'], default: '30d' })
  @IsOptional()
  @IsIn(['7d', '30d', '90d', 'all'])
  range?: AnalyticsRange;

  @ApiPropertyOptional({ description: 'Registered CAIP-19 settlement asset on an enabled chain.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  asset?: string;
}

export class AnalyticsAsset {
  @ApiProperty({ type: String })
  id: string;
  @ApiProperty({ type: String })
  chainId: string;
  @ApiProperty({ type: String })
  chainName: string;
  @ApiProperty({ type: String })
  symbol: string;
  @ApiProperty({ type: Number })
  decimals: number;
}

/** Amounts are integer strings in the selected asset's atomic units. */
export class AnalyticsFigures {
  @ApiProperty({ type: Number })
  paidCalls: number;
  @ApiProperty({ type: Number })
  payingAgents: number;
  @ApiProperty({ type: Number })
  toolsEarning: number;
  @ApiProperty({ type: Number })
  collectedCalls: number;
  @ApiProperty({ type: Number })
  refundedCalls: number;
  @ApiProperty({ type: Number })
  pendingCalls: number;
  @ApiProperty({
    type: String,
    description: 'Atomic units as an exact integer string.',
    example: '1000000',
  })
  volume: string;
  @ApiProperty({
    type: String,
    description: 'Atomic units as an exact integer string.',
    example: '1000000',
  })
  revenue: string;
  @ApiProperty({
    type: String,
    description: 'Atomic units as an exact integer string.',
    example: '1000000',
  })
  providerEarnings: string;
  @ApiProperty({
    type: String,
    description: 'Atomic units as an exact integer string.',
    example: '1000000',
  })
  refunded: string;
  @ApiProperty({
    type: String,
    description: 'Atomic units as an exact integer string.',
    example: '1000000',
  })
  pending: string;
  @ApiProperty({
    type: String,
    description: 'Atomic units as an exact integer string.',
    example: '1000000',
  })
  notCharged: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Collected / (collected + refunded); null without completed payments.',
  })
  passRate: number | null;
}

export class AnalyticsDay extends AnalyticsFigures {
  @ApiProperty({ type: String })
  day: string;
  @ApiProperty({ type: Number })
  agentsSinceLaunch: number;
  @ApiProperty({ type: Number })
  toolsSinceLaunch: number;
}

export class AnalyticsTool {
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({ type: String })
  category: string;
  @ApiProperty({ type: Number })
  paidCalls: number;
  @ApiProperty({
    type: String,
    description: 'Atomic units as an exact integer string.',
    example: '1000000',
  })
  volume: string;
  @ApiProperty({ type: Number })
  collectedCalls: number;
  @ApiProperty({ type: Number })
  refundedCalls: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Collected / (collected + refunded); null without completed payments.',
  })
  passRate: number | null;
}

/** Coarse daily groups, never individual buyer payments. */
export class AnalyticsPaymentGroup {
  @ApiProperty({ type: String })
  day: string;
  @ApiProperty({ type: String })
  tool: string;
  @ApiProperty({ type: Number })
  paidCalls: number;
  @ApiProperty({ type: Number })
  collectedCalls: number;
  @ApiProperty({ type: Number })
  refundedCalls: number;
  @ApiProperty({
    type: String,
    description: 'Atomic units as an exact integer string.',
    example: '1000000',
  })
  volume: string;
}

export class AnalyticsWindow {
  @ApiProperty({ format: 'date-time' })
  from: string;
  @ApiProperty({ format: 'date-time' })
  to: string;
  @ApiProperty({
    format: 'date-time',
    description: 'All-time charts are bounded to the latest 90 UTC days.',
  })
  chartFrom: string;
}

export class AnalyticsEscrow {
  @ApiProperty({
    type: String,
    description: 'Available ledger balance in atomic units, registered buyer escrow accounts only.',
  })
  available: string;
  @ApiProperty({
    type: String,
    description: 'Held ledger balance in atomic units, registered buyer escrow accounts only.',
  })
  held: string;
}

export class ProtocolAnalyticsResponseDto {
  @ApiProperty({ enum: ['OK', 'UNAVAILABLE'] })
  state: 'OK' | 'UNAVAILABLE';

  @ApiProperty({ description: 'Snapshot generation start time, UTC. Not a chain finality claim.' })
  generatedAt: string;

  @ApiProperty({ example: 2000 })
  cacheTtlMs: number;

  @ApiProperty({ type: [AnalyticsAsset] })
  assets: AnalyticsAsset[];

  @ApiProperty({ type: AnalyticsAsset, nullable: true })
  asset: AnalyticsAsset | null;

  @ApiProperty({ enum: ['7d', '30d', '90d', 'all'] })
  range: AnalyticsRange;

  @ApiProperty({ type: AnalyticsWindow, nullable: true })
  window: AnalyticsWindow | null;

  @ApiProperty({ type: AnalyticsFigures, nullable: true })
  totals: AnalyticsFigures | null;

  @ApiProperty({ type: AnalyticsFigures, nullable: true })
  previous: AnalyticsFigures | null;

  @ApiProperty({ type: [AnalyticsDay] })
  daily: AnalyticsDay[];

  @ApiProperty({ type: [AnalyticsTool] })
  topTools: AnalyticsTool[];

  @ApiProperty({ type: [AnalyticsPaymentGroup] })
  recent: AnalyticsPaymentGroup[];

  @ApiProperty({ type: AnalyticsEscrow, nullable: true })
  escrow: AnalyticsEscrow | null;

  @ApiProperty({
    description: 'Small/private tool groups are omitted; platform totals still include them.',
  })
  withheldForPrivacy: boolean;
}
