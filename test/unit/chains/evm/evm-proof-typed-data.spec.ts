import { privateKeyToAccount } from 'viem/accounts';

import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { ProofTypedData } from '@modules/chains/ports/payout-proof.types';

import { deployment } from './evm-fixtures';

/**
 * The two provider proofs on eip155, from the request the console is handed to
 * the signature the platform accepts.
 *
 * The backend always VERIFIED these as EIP-712 — `recover(hashTypedData(…))` —
 * but the wire carried only `message`, which is `TextDecoder` over a 32-byte
 * digest: mojibake the wallet rendered as "Sign message", then signed as an
 * EIP-191 personal message. That signature can never recover to the provider,
 * so no eip155 provider could prove a payout address or a stake authority
 * through the console. Measured 2026-09-23, in a browser.
 *
 * So each test signs the typed data the adapter hands out **as a wallet would**
 * — viem's `signTypedData` over the wire shape, decimal strings and all — and
 * asserts the adapter's own verifier accepts it. A test that hashed with the
 * adapter's helper would be a consistency check with itself.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const DEPLOYMENT = deployment(TESTNET);
const WALLET = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const ACCOUNT = toAccountId(TESTNET, WALLET.address);

const CHALLENGE = {
  account: ACCOUNT,
  organizationId: '11111111-2222-3333-4444-555555555555',
  nonce: 'ab'.repeat(32),
  expiresAt: 1_800_000_000,
};

const adapter = () => new EvmChainAdapter(new Map(), new Map([[TESTNET, DEPLOYMENT]]), [TESTNET]);

/** What a wallet does with the request: JSON in, `eth_signTypedData_v4` out. */
async function walletSigns(signer: typeof WALLET, request: ProofTypedData): Promise<string> {
  const wire = JSON.parse(JSON.stringify(request)) as ProofTypedData;
  // Loosely typed on purpose: a wallet receives JSON, not viem's inferred types.
  const sign = signer.signTypedData as (args: Record<string, unknown>) => Promise<string>;
  return sign({
    domain: { ...wire.domain, chainId: Number(wire.domain.chainId) },
    types: wire.types,
    primaryType: wire.primaryType,
    message: wire.message,
  });
}

describe.each([
  [
    'payout proof',
    (a: EvmChainAdapter) => a.payoutProofTypedData(CHALLENGE),
    (a: EvmChainAdapter, sig: string) => a.verifyPayoutProofSignature(CHALLENGE, sig, ACCOUNT),
    DEPLOYMENT.escrow,
    'PayoutProof',
  ],
  [
    'stake authority proof',
    (a: EvmChainAdapter) => a.stakeAuthorityTypedData(CHALLENGE),
    (a: EvmChainAdapter, sig: string) => a.verifyStakeAuthoritySignature(CHALLENGE, sig, ACCOUNT),
    DEPLOYMENT.stake,
    'StakeAuthorityProof',
  ],
] as const)('%s on eip155', (_name, request, verify, verifyingContract, primaryType) => {
  it('hands out typed data a wallet can sign and the adapter then accepts', async () => {
    const typed = request(adapter());
    expect(typed).not.toBeNull();
    expect(typed!.primaryType).toBe(primaryType);
    expect(typed!.domain).toEqual({
      name: 'x402 Settlement',
      version: '2',
      chainId: '46630',
      verifyingContract,
    });
    // Every integer is a decimal string: the request must survive JSON.
    expect(typed!.message.expiresAt).toBe('1800000000');

    const signature = await walletSigns(WALLET, typed!);

    expect(verify(adapter(), signature)).toBe(true);
  });

  it('refuses the same typed data signed by any other wallet', async () => {
    const signature = await walletSigns(OTHER, request(adapter())!);
    expect(verify(adapter(), signature)).toBe(false);
  });
});
