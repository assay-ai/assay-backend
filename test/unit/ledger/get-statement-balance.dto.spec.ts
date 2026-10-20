import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { GetStatementBalanceQueryDto } from '@modules/ledger/dto/get-statement-balance.dto';

const errors = async (from: string, to: string) =>
  validate(plainToInstance(GetStatementBalanceQueryDto, { from, to }));

describe('GetStatementBalanceQueryDto (B7 review m5)', () => {
  it('accepts a month and a whole leap year', async () => {
    expect(await errors('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')).toHaveLength(0);
    expect(await errors('2028-01-01T00:00:00Z', '2029-01-01T00:00:00Z')).toHaveLength(0);
  });

  it('refuses an empty or backwards period, and one over 366 days', async () => {
    for (const [from, to] of [
      ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'],
      ['2026-11-01T00:00:00Z', '2026-10-01T00:00:00Z'],
      ['2026-01-01T00:00:00Z', '2027-01-03T00:00:00Z'],
    ]) {
      const found = await errors(from, to);
      expect(found).toHaveLength(1);
      expect(found[0].constraints).toEqual({
        statementPeriod: 'to must be after from, and at most 366 days later',
      });
    }
  });
});
