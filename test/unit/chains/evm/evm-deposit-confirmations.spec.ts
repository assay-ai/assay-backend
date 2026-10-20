import { depositConfirmationsFrom } from '@modules/chains/evm/evm.module';

describe('EVM_DEPOSIT_CONFIRMATIONS', () => {
  it('unset or empty: 0, the soft confirmation', () => {
    expect(depositConfirmationsFrom(undefined)).toBe(0);
    expect(depositConfirmationsFrom('  ')).toBe(0);
  });

  it('a block count', () => {
    expect(depositConfirmationsFrom('20')).toBe(20);
  });

  it('"finalized": the chain finalized head', () => {
    expect(depositConfirmationsFrom('finalized')).toBeNull();
  });

  it('anything else refuses to boot', () => {
    for (const raw of ['-1', '1.5', 'safe', '10 blocks']) {
      expect(() => depositConfirmationsFrom(raw)).toThrow(/EVM_DEPOSIT_CONFIRMATIONS/);
    }
  });
});
