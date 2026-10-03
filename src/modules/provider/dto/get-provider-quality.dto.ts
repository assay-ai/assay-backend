import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601 } from 'class-validator';

export class GetProviderQualityQueryDto {
  @ApiProperty({ description: 'ISO 8601 — inclusive lower bound. Scopes the verdict mix only.' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'ISO 8601 — exclusive upper bound. Scopes the verdict mix only.' })
  @IsISO8601()
  to: string;
}

export class ProviderVerdictMixEntryDto {
  @ApiProperty({
    description: 'One of `VerdictStatus`, or `PENDING` for a call not yet judged',
  })
  verdict: string;

  @ApiProperty()
  calls: number;

  @ApiProperty({ description: 'calls / total calls in the window' })
  share: number;
}

/**
 * `GET /providers/me/quality` — the provider's quality position.
 *
 * `paidQualityRate`, `freeQualityRate` and `availabilityRate` are read
 * straight off `ProviderStats` (`ports/provider.types.ts`) rather than
 * recomputed from `payment_intents`: the port is *the* place paid and free
 * traffic are tracked separately, and re-deriving the split here — which
 * requires knowing each call's binding's `pricingMode`, not stored on
 * `payment_intents` — would risk folding them back together, exactly what
 * the port's own comment says must never happen. Their window is whatever
 * the bound `ProviderRegistryPort` uses (24h for availability, 7d for
 * quality) — **not** `from`/`to`; see each field's description.
 *
 * `verdictMix` is the one piece this endpoint actually derives, from
 * `verification_records`, over the requested `from`/`to`.
 */
export class GetProviderQualityResponseDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'PASS / DATA_RESULT on PAID calls. Rolling window owned by the registry snapshot, not `from`/`to`.',
  })
  paidQualityRate: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'PASS / DATA_RESULT on FREE calls. Tracked separately from `paidQualityRate` — never folded together.',
  })
  freeQualityRate: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '1 − SYSTEM_ERROR rate, rolling 24h, shared across free and paid.',
  })
  availabilityRate: number | null;

  @ApiProperty({ example: '2026-08-01T00:00:00.000Z' })
  from: string;

  @ApiProperty({ example: '2026-08-16T00:00:00.000Z' })
  to: string;

  @ApiProperty({
    type: [ProviderVerdictMixEntryDto],
    description:
      'Every verdict observed in the window, including PENDING. Derived from verification_records.',
  })
  verdictMix: ProviderVerdictMixEntryDto[];

  @ApiProperty({ description: 'Σ calls behind `verdictMix`' })
  totalCalls: number;
}
