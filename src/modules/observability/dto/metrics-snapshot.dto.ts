import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { SignalAvailability } from '../domain/signal-catalog';

/** `evaluateGoldenSignal`/`evaluateReserveHealth`'s verdict, carried into the JSON snapshot. */
export class SignalGateDto {
  @ApiProperty({ enum: ['OK', 'WARN', 'CRITICAL'] })
  status: 'OK' | 'WARN' | 'CRITICAL';

  @ApiProperty({
    description: 'The human sentence evaluateGoldenSignal produced, threshold included.',
  })
  summary: string;
}

export class ReconciliationAssetRowDto {
  @ApiProperty({ description: 'CAIP-19 asset id.' })
  asset: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'vault_balance − total_liabilities, display units. Null when the last run recorded a read failure.',
  })
  differenceDisplay: number | null;

  @ApiProperty({ enum: ['OK', 'WARN', 'CRITICAL'] })
  severity: string;

  @ApiProperty({
    description: "Seconds since the latest run started — staleness, not the run's own duration.",
  })
  ageSeconds: number;

  @ApiPropertyOptional({ type: SignalGateDto, nullable: true })
  gate: SignalGateDto | null;
}

export class PolicyFailRateRowDto {
  @ApiProperty()
  policyId: string;

  @ApiProperty()
  policyVersion: number;

  @ApiProperty({
    description: 'Verdicts counted in the trailing window (verdict_status IS NOT NULL).',
  })
  total: number;

  @ApiProperty({ description: 'FAIL verdicts / total, trailing window.' })
  failRate: number;
}

/** Which dashboard table a reading belongs to. */
export type SignalSection = 'money' | 'traffic' | 'oauth' | 'other';

export class SignalReadingDto {
  @ApiProperty({
    description: 'ObservabilitySignal member, or a bonus reading name — see the service.',
  })
  signal: string;

  @ApiProperty()
  label: string;

  @ApiProperty({ enum: ['money', 'traffic', 'oauth', 'other'] })
  section: SignalSection;

  @ApiProperty({ enum: SignalAvailability })
  availability: SignalAvailability;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null when NONE, or when the window has no data.',
  })
  value: number | null;

  @ApiProperty()
  unit: string;

  @ApiPropertyOptional({
    type: SignalGateDto,
    nullable: true,
    description: 'Null when this signal has no alert threshold.',
  })
  gate: SignalGateDto | null;

  @ApiPropertyOptional({ nullable: true })
  reason: string | null;

  @ApiPropertyOptional({
    description: 'Extra numbers that do not fit `value` alone, e.g. a count beside an age.',
  })
  extra?: Record<string, number | undefined>;
}

/** `GET /operator/dashboard/data.json`, and the object the HTML dashboard is rendered from. */
export class MetricsSnapshotDto {
  @ApiProperty()
  generatedAt: string;

  @ApiProperty({
    description: 'How long this snapshot is reused before the next request re-runs the queries.',
  })
  cacheTtlMs: number;

  @ApiProperty({ type: [ReconciliationAssetRowDto] })
  reconciliation: ReconciliationAssetRowDto[];

  @ApiProperty({ type: [PolicyFailRateRowDto] })
  failRateByPolicy: PolicyFailRateRowDto[];

  @ApiProperty({ type: [SignalReadingDto] })
  signals: SignalReadingDto[];
}
