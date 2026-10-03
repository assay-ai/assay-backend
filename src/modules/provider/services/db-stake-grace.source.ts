import { Injectable } from '@nestjs/common';
import { In, IsNull } from 'typeorm';

import { ProviderStakeGraceRepository } from '@database/postgres/repositories/provider-stake-grace.repository';

import { StakeGraceLookup, StakeGracePort } from '../ports/stake-grace.port';

/**
 * Open grace periods, from `provider_stake_grace`.
 *
 * One statement per routing decision, over every candidate binding at once.
 * `uq_provider_stake_grace_open` — `UNIQUE (binding_id) WHERE resolved_at IS
 * NULL` — is precisely this lookup, which is why the predicate below is written
 * to match it exactly rather than to be convenient: the partial index is the
 * whole access path, and it also guarantees the "at most one open row per
 * binding" that the returned map assumes.
 *
 * ## Scoped, not cross-tenant
 *
 * `providerId === organizationId` across the whole provider surface, and the
 * candidate set names every provider it is about — so this is an ordinary
 * scoped read over a set of organizations, the same shape as
 * `DbProviderRegistry.findRoutingStates`, and it stays inside the guard. It is
 * deliberately **not** the cross-tenant `IS NOT NULL` idiom that
 * `ToolBindingRepository.findByTool` needs — the one that satisfies the scope
 * guard while reading every tenant's rows, and that
 * `test/unit/shared/api/surface-consistency.spec.ts` allowlists file by file.
 * That read is about which providers exist for a tool, a question no tenant can
 * answer about itself; this one is asked about bindings whose owning
 * organizations are already in hand, so it needs no allowlist entry.
 * `ProviderStakeGraceRepository`'s own doc comment made this call before there
 * was a caller, and it was right.
 *
 * ## Expired rows are returned, on purpose
 *
 * `resolved_at IS NULL` and nothing else. A row past its `expires_at` that the
 * sweeper has not closed yet is exactly the case that must come back as
 * `STAKE_GRACE_EXPIRED`, and dropping it here would report the provider's
 * shortfall as though they had never had a grace period at all — during the few
 * minutes when the difference is the entire explanation for why their traffic
 * stopped. The comparison against `now` is `applyStakeGrace`'s, where it is
 * pure and replayable.
 */
@Injectable()
export class DbStakeGraceSource implements StakeGracePort {
  constructor(private readonly grace: ProviderStakeGraceRepository) {}

  async openGraceUntil(bindings: readonly StakeGraceLookup[]): Promise<ReadonlyMap<string, Date>> {
    const found = new Map<string, Date>();
    if (bindings.length === 0) return found;

    // The blank provider id is what `unknownProvider()` carries for a binding
    // whose registry row is missing. Such a binding is refused by
    // `PROVIDER_UNKNOWN` long before grace is consulted, and passing `''` into
    // the scope predicate would only widen the statement for nothing.
    const organizationIds = [
      ...new Set(bindings.map((entry) => entry.providerId).filter((id) => id !== '')),
    ];
    if (organizationIds.length === 0) return found;

    const bindingIds = [...new Set(bindings.map((entry) => entry.bindingId))];

    const rows = await this.grace.find({
      where: {
        organizationId: In(organizationIds),
        bindingId: In(bindingIds),
        resolvedAt: IsNull(),
      },
    });

    for (const row of rows) {
      found.set(row.bindingId, row.expiresAt);
    }

    return found;
  }
}
