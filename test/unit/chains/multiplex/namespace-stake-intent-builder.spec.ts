import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { NamespaceStakeIntentBuilder } from '@modules/chains/multiplex/namespace-stake-intent-builder';
import { CHAIN_IDS, ChainNamespace, toAccountId } from '@modules/chains/ports/caip.types';
import {
  StakeIntentBuilderPort,
  StakeIntentKind,
} from '@modules/provider/ports/stake-intent-builder.port';

import { expectErrorCode, expectErrorCodeAsync } from '../../helpers/expect-error-code';

/**
 * `STAKE_INTENT_BUILDER` was bound `useExisting: SolanaStakeIntentBuilder` for
 * every chain, so an eip155 provider's deposit reached a base58 decoder. Each
 * fake below answers with its own namespace's name, so "dispatched correctly"
 * and "dispatched at all" are different assertions.
 */
const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;

const SOLANA_PROVIDER = toAccountId(SOLANA, 'ProviderAccount111111111111111111111111111');
const EVM_PROVIDER = toAccountId(EVM, '0x31b1DF6F36ec62075a3BE03a5C0BebB06534bA72');

function fake(name: string, needsOpen: boolean): StakeIntentBuilderPort {
  return {
    stakeAsset: jest.fn().mockResolvedValue({ asset: `${name}-asset`, decimals: 6 }),
    needsOpenStake: jest.fn().mockReturnValue(needsOpen),
    preflight: jest.fn().mockResolvedValue({ from: name }),
    buildIntent: jest.fn().mockResolvedValue({ transaction: { from: name }, preflight: {} }),
    confirmedDeposit: jest.fn().mockResolvedValue({ from: name }),
  } as unknown as StakeIntentBuilderPort;
}

describe('NamespaceStakeIntentBuilder', () => {
  const solana = fake('solana', true);
  const evm = fake('eip155', false);
  const builder = new NamespaceStakeIntentBuilder(
    new Map<string, StakeIntentBuilderPort>([
      [ChainNamespace.SOLANA, solana],
      [ChainNamespace.EIP155, evm],
    ]),
  );

  it('dispatches the chain-keyed questions on the chain', async () => {
    await expect(builder.stakeAsset(EVM)).resolves.toMatchObject({ asset: 'eip155-asset' });
    expect(builder.needsOpenStake(EVM)).toBe(false);
    expect(builder.needsOpenStake(SOLANA)).toBe(true);
  });

  it('dispatches a request on its account, never on a configured default', async () => {
    const request = { kind: StakeIntentKind.DEPOSIT, account: EVM_PROVIDER, amount: null };

    await expect(builder.buildIntent(request)).resolves.toMatchObject({
      transaction: { from: 'eip155' },
    });
    await expect(builder.preflight({ ...request, account: SOLANA_PROVIDER })).resolves.toEqual({
      from: 'solana',
    });
    await expect(
      builder.confirmedDeposit('0xabc', EVM_PROVIDER, {
        funder: EVM_PROVIDER,
        after: new Date(0),
      }),
    ).resolves.toEqual({
      from: 'eip155',
    });
  });

  it('refuses a namespace nobody wired, by name', async () => {
    const solanaOnly = new NamespaceStakeIntentBuilder(
      new Map<string, StakeIntentBuilderPort>([[ChainNamespace.SOLANA, solana]]),
    );

    expectErrorCode(() => solanaOnly.needsOpenStake(EVM), ChainErrorCode.CHAIN_UNSUPPORTED);
    await expectErrorCodeAsync(() => solanaOnly.stakeAsset(EVM), ChainErrorCode.CHAIN_UNSUPPORTED);
  });
});
