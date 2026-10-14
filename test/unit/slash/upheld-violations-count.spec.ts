import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';

import { fakeQueryBuilder } from '../provider/helpers/fake-query-builder';

/**
 * `countUpheldViolationsByProvider` (the arbiter page's `upheldViolations30d`)
 * counts what the chain took and what nobody ruled against (review N-4), not
 * only the case statuses that say so.
 */
describe('SlashProposalRepository.countUpheldViolationsByProvider', () => {
  it('counts a case with an executed record, and one whose undisputed record lapsed', async () => {
    const fake = fakeQueryBuilder([{ providerId: 'provider-1', count: '2' }]);
    const repository = Object.create(SlashProposalRepository.prototype) as SlashProposalRepository;
    Object.defineProperty(repository, 'manager', {
      value: { createQueryBuilder: () => fake.qb },
    });

    const counts = await repository.countUpheldViolationsByProvider(
      ['provider-1'],
      new Date('2026-09-15T00:00:00Z'),
    );

    expect(counts.get('provider-1')).toBe(2);
    const sql = fake.wheres.map((where) => where.sql).join('\n');
    // Executed, whoever ran it and whether or not a part was disputed.
    expect(sql).toContain("part.chain_status = 'EXECUTED'");
    expect(sql).toContain('proposal.executed_at IS NOT NULL');
    // Lapsed undisputed: nobody ruled for the provider.
    expect(sql).toContain("part.cancel_reason IN ('EXPIRED', 'VERIFIER_UNAVAILABLE')");
    expect(sql).toContain('part.chain_disputed_at IS NULL');
    expect(sql).toContain("proposal.status <> 'REVERSED'");
  });
});
