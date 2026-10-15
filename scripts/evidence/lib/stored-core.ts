import { jsonbSafeTransformer } from '../../../src/database/postgres/entities/jsonb-safe.transformer';
import { computeContentHash } from '../../../src/modules/verification/domain/evidence/pack';
import type { EvidenceCore } from '../../../src/modules/verification/domain/evidence/pack.types';

/**
 * Recomputes a pack's content hash from its `core` as raw SQL returns it.
 *
 * `evidence_packs.core` is written through the jsonb-safe transformer, and the
 * sealer hashed the value *before* that encoding. A raw `query()` skips the
 * entity's transformer, so the core is decoded here first — otherwise any
 * pack whose core holds an escaped string would look tampered with
 * (round-two review R2-2).
 */
export function storedContentHash(input: {
  readonly core: EvidenceCore;
  readonly seq: number;
  readonly prevHash: string | null;
}): string {
  return computeContentHash({
    core: jsonbSafeTransformer.from(input.core) as EvidenceCore,
    seq: input.seq,
    prevHash: input.prevHash,
  });
}
