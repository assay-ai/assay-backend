import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { NamespaceRelayedEscrowIntent } from '@modules/chains/multiplex/namespace-relayed-escrow-intent';
import {
  AccountId,
  CHAIN_IDS,
  ChainNamespace,
  toAccountId,
} from '@modules/chains/ports/caip.types';
import { EscrowIntentKind } from '@modules/settlement/ports/escrow-intent-builder.port';
import {
  RelayedEscrowIntent,
  RelayedEscrowIntentPort,
} from '@modules/settlement/ports/relayed-escrow-intent.port';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * `NamespaceRelayedEscrowIntent` — one entry, and the refusal that entry's
 * absence produces.
 *
 * This is asserted here rather than against a live deployment because a live
 * Solana session never gets this far: `EscrowController` resolves the escrow
 * asset first, and on a Solana account that read fails (or succeeds) for
 * entirely unrelated reasons. The claim "a Solana account cannot reach a
 * relayed door" is therefore only provable at this layer, and it is worth
 * proving — a stub in the Solana slot would make it false, and nothing else in
 * the suite would notice.
 */
const EVM: AccountId = toAccountId(
  CHAIN_IDS.ROBINHOOD_TESTNET,
  '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4',
);
const SOLANA: AccountId = toAccountId(
  CHAIN_IDS.SOLANA_DEVNET,
  'BuyerAccount111111111111111111111111111111',
);

const SUBMISSION = { transactionHash: '0xabc1', blockNumber: '11', gasUsed: '65536' };

function intent(account: AccountId): RelayedEscrowIntent {
  return {
    kind: EscrowIntentKind.SET_LIMITS,
    account,
    maxVoucherAmount: 1n,
    maxPerWindow: 2n,
    nonce: 0n,
    deadline: 1_789_139_970n,
    signature: `0x${'ab'.repeat(64)}1b`,
  };
}

describe('NamespaceRelayedEscrowIntent', () => {
  const evm: RelayedEscrowIntentPort = { submit: jest.fn().mockResolvedValue(SUBMISSION) };
  const build = () => new NamespaceRelayedEscrowIntent(new Map([[ChainNamespace.EIP155, evm]]));

  it('dispatches an eip155 account to the EVM implementation', async () => {
    await expect(build().submit(intent(EVM))).resolves.toEqual(SUBMISSION);
    expect(evm.submit).toHaveBeenCalledWith(intent(EVM));
  });

  /**
   * Not "it returns null", not "it answers UNAVAILABLE". Solana's buyer doors
   * are transactions the buyer signs and sends with their own SOL — there is no
   * meta-transaction, no `authNonce` and no EIP-712 request to carry — so the
   * only honest answer is that this chain does not have the operation.
   */
  it('refuses a solana account by name, and reaches no implementation', async () => {
    await expectErrorCodeAsync(
      () => build().submit(intent(SOLANA)),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
  });

  it('refuses when the eip155 entry itself is missing, rather than failing silently', async () => {
    const empty = new NamespaceRelayedEscrowIntent(new Map());
    await expectErrorCodeAsync(() => empty.submit(intent(EVM)), ChainErrorCode.CHAIN_UNSUPPORTED);
  });
});
