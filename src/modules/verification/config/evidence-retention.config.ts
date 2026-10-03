import { ConfigService } from '@nestjs/config';

/**
 * How long the raw bodies behind an evidence pack are kept.
 *
 * 72 hours is a **published** figure, not a tuning knob: the security model
 * states it, `DisputeEntity`'s own comment assumes it, and the provider-facing
 * dispute window is built on top of it. Lowering it silently would take evidence
 * away from a provider who is still inside the window the product promised
 * them; raising it silently would keep request bodies the platform said it
 * would not keep. Either direction is a decision someone must make on purpose,
 * which is why it is a named environment variable with the published value as
 * its default rather than a literal buried in the sweep.
 *
 * The sweep is the only consumer that reads the number; the sealer stamps
 * `expires_at` from it once, at seal time, so changing it later moves the
 * deadline for bodies sealed *after* the change and leaves already-sealed rows
 * alone. That is the honest behaviour: a body's deadline was fixed by the
 * policy in force when the call happened.
 */
export const EVIDENCE_RETENTION_CONFIG = Symbol('EVIDENCE_RETENTION_CONFIG');

export interface EvidenceRetentionConfig {
  /** Hours a raw body survives after its pack was sealed. */
  readonly bodyRetentionHours: number;
  /** Rows removed per sweep pass; the sweep runs again in an hour. */
  readonly sweepBatchSize: number;
}

export const DEFAULT_EVIDENCE_RETENTION: EvidenceRetentionConfig = {
  bodyRetentionHours: 72,
  sweepBatchSize: 500,
};

export function evidenceRetentionConfigFactory(
  configService: ConfigService,
): EvidenceRetentionConfig {
  return {
    bodyRetentionHours: positive(
      configService.get<string>('EVIDENCE_BODY_RETENTION_HOURS'),
      DEFAULT_EVIDENCE_RETENTION.bodyRetentionHours,
    ),
    sweepBatchSize: positive(
      configService.get<string>('EVIDENCE_SWEEP_BATCH_SIZE'),
      DEFAULT_EVIDENCE_RETENTION.sweepBatchSize,
    ),
  };
}

/**
 * `''`, `0`, a negative and `NaN` all fall back to the constant.
 *
 * Zero is the dangerous one and the reason this is not `Number(x) || default`
 * spelled inline: `EVIDENCE_BODY_RETENTION_HOURS=0` reads like "keep nothing"
 * and would delete a body in the same hour it was sealed — inside the window a
 * dispute is filed in. A deployment that means it can say `1`.
 */
function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
