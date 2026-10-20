import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { depositConfirmationsFrom } from '@modules/chains/evm/evm.module';

/** What the insufficient-funds text promises about a pending deposit. */
describe('EvmChainAdapter.depositCreditsOnSoftConfirmation', () => {
  const adapter = (raw: string | undefined) =>
    new EvmChainAdapter(new Map(), new Map(), [], depositConfirmationsFrom(raw));

  it('is true only when a deposit is credited on its receipt (EVM_DEPOSIT_CONFIRMATIONS unset or 0)', () => {
    expect(adapter(undefined).depositCreditsOnSoftConfirmation).toBe(true);
    expect(adapter('0').depositCreditsOnSoftConfirmation).toBe(true);
    expect(adapter('12').depositCreditsOnSoftConfirmation).toBe(false);
    expect(adapter('finalized').depositCreditsOnSoftConfirmation).toBe(false);
  });
});
