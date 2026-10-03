import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import {
  NamespaceWithdrawGasGrant,
  NoWithdrawGasGrant,
} from '@modules/chains/multiplex/namespace-withdraw-gas-grant';
import {
  AccountId,
  CHAIN_IDS,
  ChainNamespace,
  toAccountId,
} from '@modules/chains/ports/caip.types';
import {
  GasGrantRefusal,
  WithdrawGasGrantPort,
} from '@modules/settlement/ports/withdraw-gas-grant.port';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const ORG = 'org-11111111-1111-4111-8111-111111111111';
const EVM_BUYER: AccountId = toAccountId(
  CHAIN_IDS.ROBINHOOD_TESTNET,
  '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4',
);
const SOLANA_BUYER: AccountId = toAccountId(
  CHAIN_IDS.SOLANA_DEVNET,
  'BuyerAccount111111111111111111111111111111',
);

const GRANTED = { kind: 'GRANTED' as const, hash: `0x${'ab'.repeat(32)}`, wei: 1n };

describe('NamespaceWithdrawGasGrant', () => {
  const evm: WithdrawGasGrantPort = { grantWithdrawGas: jest.fn().mockResolvedValue(GRANTED) };

  function build(entries: [string, WithdrawGasGrantPort][]) {
    return new NamespaceWithdrawGasGrant(new Map(entries));
  }

  const complete = (): NamespaceWithdrawGasGrant =>
    build([
      [ChainNamespace.SOLANA, new NoWithdrawGasGrant()],
      [ChainNamespace.EIP155, evm],
    ]);

  beforeEach(() => jest.clearAllMocks());

  it('routes an eip155 account to the EVM grant, arguments intact', async () => {
    expect(await complete().grantWithdrawGas(ORG, EVM_BUYER)).toEqual(GRANTED);
    expect(evm.grantWithdrawGas).toHaveBeenCalledWith(ORG, EVM_BUYER);
  });

  it('answers null for Solana without touching the EVM grant', async () => {
    // Solana's `withdraw` is signed and paid for out of SOL the account already
    // holds, so there is no grant to make. Dispatching it to the EVM
    // implementation would ask a viem client about a base58 address.
    expect(await complete().grantWithdrawGas(ORG, SOLANA_BUYER)).toBeNull();
    expect(evm.grantWithdrawGas).not.toHaveBeenCalled();
  });

  it('refuses a namespace nobody wired up, rather than answering null', async () => {
    /*
      The failure this file exists to prevent. The obvious implementation is a
      map holding only `eip155` and `?? null` on a miss — "no implementation
      means no grant" — which is indistinguishable from Solana's deliberate
      `null` and would make a third chain, added and never wired, silently
      report "this chain has no gas grant" on every withdrawal.

      So the miss is loud, and Solana's `null` comes from an entry somebody
      wrote. This case is the one that tells those two apart: the same call that
      answers `null` above must THROW here.
    */
    const missingSolana = build([[ChainNamespace.EIP155, evm]]);

    await expectErrorCodeAsync(
      () => missingSolana.grantWithdrawGas(ORG, SOLANA_BUYER),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
  });

  it('propagates a refusal unchanged', async () => {
    const refusing: WithdrawGasGrantPort = {
      grantWithdrawGas: async () => ({
        kind: 'REFUSED',
        reason: GasGrantRefusal.ALREADY_GRANTED,
      }),
    };

    expect(
      await build([[ChainNamespace.EIP155, refusing]]).grantWithdrawGas(ORG, EVM_BUYER),
    ).toEqual({ kind: 'REFUSED', reason: GasGrantRefusal.ALREADY_GRANTED });
  });
});

describe('NoWithdrawGasGrant', () => {
  it('answers null for anything, and holds no state that could make it answer otherwise', async () => {
    const none = new NoWithdrawGasGrant();

    expect(await none.grantWithdrawGas()).toBeNull();
    expect(await none.grantWithdrawGas()).toBeNull();
  });
});
