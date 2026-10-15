import {
  JSONB_ESCAPE_MARK,
  jsonbSafeTransformer,
} from '@database/postgres/entities/jsonb-safe.transformer';
import { computeContentHash } from '@modules/verification/domain/evidence/pack';
import type { EvidenceCore } from '@modules/verification/domain/evidence/pack.types';

import { storedContentHash } from '../../../scripts/evidence/lib/stored-core';

/**
 * Round-two review R2-2: `verify-chain` reads `core` with raw SQL, which skips
 * the jsonb-safe transformer. The sealer hashed the unencoded core, so a pack
 * whose core held an escaped string was reported as tampered.
 */
describe('storedContentHash', () => {
  const core = {
    rule: 'body echoed: nul\u0000 lone\ud800',
    marked: `${JSONB_ESCAPE_MARK}x`,
  } as unknown as EvidenceCore;
  const sealed = computeContentHash({ core, seq: 7, prevHash: 'abc' });

  it('recomputes the sealed hash from the core as raw SQL returns it', () => {
    const stored = JSON.parse(JSON.stringify(jsonbSafeTransformer.to(core))) as EvidenceCore;
    expect(computeContentHash({ core: stored, seq: 7, prevHash: 'abc' })).not.toBe(sealed);
    expect(storedContentHash({ core: stored, seq: 7, prevHash: 'abc' })).toBe(sealed);
  });

  it('still notices a rewritten core', () => {
    const stored = JSON.parse(
      JSON.stringify(jsonbSafeTransformer.to({ ...core, rule: 'rewritten' })),
    ) as EvidenceCore;
    expect(storedContentHash({ core: stored, seq: 7, prevHash: 'abc' })).not.toBe(sealed);
  });
});
