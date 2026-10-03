import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { NamespaceFacilitator } from '@modules/chains/multiplex/namespace-facilitator';
import { CHAIN_IDS, ChainNamespace, ChainId } from '@modules/chains/ports/caip.types';
import { FacilitatorPort } from '@modules/chains/ports/facilitator.port';
import { PaymentPayload, PaymentRequirements } from '@modules/chains/ports/x402.types';

import { expectErrorCodeAsync } from '../../helpers/expect-error-code';

/**
 * Each fake answers with its own name, so "dispatched to the right member" and
 * "dispatched at all" are different assertions.
 */
const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;

function member(name: string): jest.Mocked<FacilitatorPort> {
  return {
    name,
    supports: jest.fn().mockResolvedValue(true),
    verify: jest.fn().mockResolvedValue({ isValid: false, invalidReason: name }),
    settle: jest.fn().mockResolvedValue({ success: false, network: SOLANA, errorReason: name }),
    getFeePayer: jest.fn().mockResolvedValue(`${name}-fee-payer`),
  } as unknown as jest.Mocked<FacilitatorPort>;
}

const requirementsOn = (network: ChainId) => ({ network }) as PaymentRequirements;
const payloadOn = (network: ChainId) => ({ network }) as PaymentPayload;

function build() {
  const solana = member('solana');
  const evm = member('evm');
  const facilitator = new NamespaceFacilitator(
    new Map<string, FacilitatorPort>([
      [ChainNamespace.SOLANA, solana],
      [ChainNamespace.EIP155, evm],
    ]),
  );
  return { facilitator, solana, evm };
}

describe('NamespaceFacilitator', () => {
  it('sends an eip155 verify and settle to the eip155 member', async () => {
    const { facilitator, evm, solana } = build();
    await expect(facilitator.verify(payloadOn(EVM), requirementsOn(EVM))).resolves.toMatchObject({
      invalidReason: 'evm',
    });
    await expect(facilitator.settle(payloadOn(EVM), requirementsOn(EVM))).resolves.toMatchObject({
      errorReason: 'evm',
    });
    expect(solana.verify).not.toHaveBeenCalled();
    expect(evm.settle).toHaveBeenCalledTimes(1);
  });

  it('dispatches on what was ADVERTISED, not on the network the client wrote', async () => {
    const { facilitator, solana, evm } = build();
    await facilitator.verify(payloadOn(EVM), requirementsOn(SOLANA));
    expect(solana.verify).toHaveBeenCalledTimes(1);
    expect(evm.verify).not.toHaveBeenCalled();
  });

  it('keeps Solana on the Solana member, fee payer included', async () => {
    const { facilitator } = build();
    await expect(facilitator.getFeePayer(SOLANA)).resolves.toBe('solana-fee-payer');
    await expect(
      facilitator.verify(payloadOn(SOLANA), requirementsOn(SOLANA)),
    ).resolves.toMatchObject({ invalidReason: 'solana' });
  });

  it('answers supports=false for an unserved namespace, and refuses to verify on one', async () => {
    const facilitator = new NamespaceFacilitator(
      new Map<string, FacilitatorPort>([[ChainNamespace.SOLANA, member('solana')]]),
    );
    await expect(facilitator.supports(EVM, 'exact')).resolves.toBe(false);
    await expectErrorCodeAsync(
      () => facilitator.verify(payloadOn(EVM), requirementsOn(EVM)),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
  });
});
