import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { DUPLICATE_SETTLEMENT_TTL_SECONDS } from './facilitator-policy.constants';

/**
 * Rule 6 — duplicate settlement: reject a payload already in flight, cache
 * evicted after 120 seconds (twice the blockhash lifetime).
 *
 * A `SET key value EX 120 NX` is the whole mechanism: atomic reserve-or-fail in
 * one round trip, so two concurrent `/settle` calls for the same payload cannot
 * both observe "not reserved yet" and both broadcast. This is a fast path, not
 * the durable guarantee — flushing Redis must never enable a double spend,
 * so `FacilitatorService` also treats a second broadcast of the same
 * transaction (caught by the chain itself, or by the intent's own
 * compare-and-swap upstream) as safe, not merely "should not happen".
 *
 * Only `/settle` calls this. `/verify` is a pure, retried read
 * (`http-facilitator.adapter.ts`) — consulting or mutating this cache from
 * `/verify` would make repeated preflight checks fail the second time.
 */
@Injectable()
export class DuplicateSettlementGuard {
  constructor(@Inject(CacheService) private readonly cache: Pick<CacheService, 'setWithOptions'>) {}

  /** `true` if this is the first time this exact transaction was presented. */
  async reserve(rawTransactionBase64: string): Promise<boolean> {
    const key = `facilitator:settle:${hashOf(rawTransactionBase64)}`;
    const result = await this.cache.setWithOptions(
      key,
      '1',
      'EX',
      DUPLICATE_SETTLEMENT_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }
}

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
