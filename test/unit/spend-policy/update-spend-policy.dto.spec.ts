import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateSpendPolicyDto } from '@modules/spend-policy/dto/update-spend-policy.dto';
import { AgentRulesInputDto } from '@modules/toolset/dto/agent-access.dto';
import { EntryMaxPriceDto } from '@modules/toolset/dto/toolset.dto';
import { MONEY_MAX_ATOMIC_UNITS } from '@shared/utils/money.util';

const U64_MAX = MONEY_MAX_ATOMIC_UNITS.toString();
const OVER_U64 = (MONEY_MAX_ATOMIC_UNITS + 1n).toString();

const errorsOn = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(UpdateSpendPolicyDto, body))).map((e) => e.property);

/**
 * A cap is stored and read back through `MoneyUtil.of`, which refuses anything
 * above u64. A 21–78 digit value used to pass a digits-only regex, get written,
 * and then 500 every read of the caller's own policy — so the edge refuses it.
 */
describe('Atomic-amount fields refuse what MoneyUtil cannot read back', () => {
  const fields = [
    'perCallMax',
    'dailyCap',
    'monthlyCap',
    'maxSpendPerHour',
    'requireApprovalAbove',
  ];

  it.each(fields)('%s: accepts 0, u64 max and null', async (field) => {
    for (const value of ['0', '10000', U64_MAX, null]) {
      expect(await errorsOn({ [field]: value })).toEqual([]);
    }
  });

  it.each(fields)('%s: refuses u64 max + 1, 78 digits, and non-digits', async (field) => {
    for (const value of [OVER_U64, '9'.repeat(78), '9'.repeat(79), '-1', '1.5', '', 42]) {
      expect(await errorsOn({ [field]: value })).toEqual([field]);
    }
  });

  it('applies the same bound to agent-access maxPrice and toolset entry maxPrice', async () => {
    expect(await validate(plainToInstance(AgentRulesInputDto, { maxPrice: U64_MAX }))).toHaveLength(
      0,
    );
    expect(
      await validate(plainToInstance(AgentRulesInputDto, { maxPrice: OVER_U64 })),
    ).not.toHaveLength(0);

    const entry = (amount: string) =>
      validate(plainToInstance(EntryMaxPriceDto, { amount, asset: 'eip155:1/erc20:0xabc' }));
    expect((await entry(U64_MAX)).map((e) => e.property)).not.toContain('amount');
    expect((await entry(OVER_U64)).map((e) => e.property)).toContain('amount');
  });
});
