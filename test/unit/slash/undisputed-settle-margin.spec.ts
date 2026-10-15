import { Brackets } from 'typeorm';

import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { CHAIN_DISPUTE_SETTLE_MS } from '@modules/slash/constants/slash.constants';

/**
 * Review R2-2: the undisputed sweep upholds an EVM case only once every
 * undisputed record of it has passed its door by the settle margin, so a
 * `disputeSlash` that landed just before the door is mirrored first.
 */
describe('SlashProposalRepository.findUndisputedPast (EVM)', () => {
  function capture() {
    const sql: string[] = [];
    const params: Record<string, unknown> = {};
    const selects: string[] = [];
    const recorder: Record<string, unknown> = {};
    const add = (clause: unknown, p?: Record<string, unknown>) => {
      if (clause instanceof Brackets) {
        clause.whereFactory(recorder as never);
      } else {
        sql.push(String(clause));
      }
      Object.assign(params, p ?? {});
      return recorder;
    };
    Object.assign(recorder, {
      select: (expr: string) => (selects.push(expr), recorder),
      addSelect: (expr: string) => (selects.push(expr), recorder),
      where: add,
      andWhere: add,
      orWhere: add,
      setParameters: (p: Record<string, unknown>) => (Object.assign(params, p), recorder),
      orderBy: () => recorder,
      limit: () => recorder,
      getRawMany: async () => [],
    });
    const repository = Object.create(SlashProposalRepository.prototype) as SlashProposalRepository;
    Object.defineProperty(repository, 'manager', {
      value: { createQueryBuilder: () => recorder },
    });
    return { repository, sql, params, selects };
  }

  it('waits the settle margin past every undisputed door, and says when the arbiter upheld one', async () => {
    const { repository, sql, params, selects } = capture();
    const now = new Date('2026-10-17T01:00:00Z');
    await repository.findUndisputedPast(now, 10);

    const text = sql.join('\n');
    expect(text).toContain('proposal.chain_executable_at <= :settled');
    expect(params.settled).toEqual(new Date(now.getTime() - CHAIN_DISPUTE_SETTLE_MS));
    // A part's own door, not only the case's mirror.
    expect(text).toContain('part.chain_disputed_at IS NULL');
    expect(text).toContain('part.chain_executable_at > :settled');
    expect(selects.join('\n')).toContain('part.chain_disputed_at IS NOT NULL');
  });
});
