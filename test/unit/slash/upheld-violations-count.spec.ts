import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';

import { fakeQueryBuilder } from '../provider/helpers/fake-query-builder';

/**
 * `countUpheldViolationsByProvider` (the arbiter page's `upheldViolations30d`)
 * counts only the cases the provider actually lost (review R2-1): on EVM a
 * record executed on chain, or the arbiter's on-chain uphold; never a case
 * closed in the provider's favour, a verifier-key lapse, or a record that
 * expired because the platform did not execute it in time.
 */
describe('SlashProposalRepository.countUpheldViolationsByProvider', () => {
  async function sqlOf() {
    const fake = fakeQueryBuilder([{ providerId: 'provider-1', count: '2' }]);
    const repository = Object.create(SlashProposalRepository.prototype) as SlashProposalRepository;
    Object.defineProperty(repository, 'manager', {
      value: { createQueryBuilder: () => fake.qb },
    });
    const counts = await repository.countUpheldViolationsByProvider(
      ['provider-1'],
      new Date('2026-09-15T00:00:00Z'),
    );
    return {
      counts,
      sql: fake.wheres.map((where) => where.sql).join('\n'),
      params: Object.assign({}, ...fake.wheres.map((where) => where.params)),
    };
  }

  it('counts an executed record and an arbiter uphold', async () => {
    const { counts, sql, params } = await sqlOf();
    expect(counts.get('provider-1')).toBe(2);
    // Executed, whoever ran it and whether or not a part was disputed.
    expect(sql).toContain("part.chain_status = 'EXECUTED'");
    expect(sql).toContain('proposal.executed_at IS NOT NULL');
    // The arbiter's uphold, only while the case still stands upheld.
    expect(sql).toContain("proposal.resolution_kind = 'CHAIN_ARBITER'");
    expect(params.upheld).toEqual(['UPHELD', 'EXECUTING', 'EXECUTED']);
  });

  it('R2-1: excludes cases won by the provider and records that lapsed or expired', async () => {
    const { sql, params } = await sqlOf();
    expect(sql).toContain('proposal.status NOT IN (:...providerWon)');
    expect(params.providerWon).toEqual(['OVERTURNED', 'WAIVED', 'REVERSED']);
    // No branch counts a cancelled record: a verifier-key lapse voids the case
    // for reasons that say nothing about the provider, and a record the
    // platform failed to execute in time expires in the provider's favour.
    expect(sql).not.toContain('cancel_reason');
    expect(sql).not.toContain("'CANCELLED'");
    // A case the platform only labelled upheld (AUTO_UNDISPUTED) does not
    // count until a record of it executes; the arbiter's uphold counts.
    expect(sql).toContain("proposal.resolution_kind = 'CHAIN_ARBITER'");
    expect(sql).not.toContain('asset_id');
  });
});
