import { secp256k1 } from '@noble/curves/secp256k1';
import { encodeFunctionData, getAddress, keccak256, serializeTransaction } from 'viem';

import { X402_ESCROW_ABI } from '@modules/chains/evm/abi/x402.abi';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import { AccountId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';

/**
 * Deployment records for the EVM unit suites.
 *
 * Every address is **distinct per chain and per role**. Sharing one address
 * across two roles would make a test that confuses the escrow with the stake
 * contract pass — and `verifyingContract` is the only thing separating the two
 * EIP-712 domains, so that confusion is exactly the one worth catching.
 *
 * They are written all-lower-case on purpose: an all-lower-case address makes
 * no EIP-55 checksum claim, so these stay valid without anybody having to
 * hand-compute a checksum for a fictional contract. The adapter normalises.
 */
const ADDRESSES: Readonly<Record<string, Omit<EvmDeployment, 'chainId'>>> = {
  [CHAIN_IDS.ROBINHOOD_TESTNET]: {
    config: '0x1111111111111111111111111111111111111111',
    stake: '0x2222222222222222222222222222222222222222',
    escrow: '0x3333333333333333333333333333333333333333',
    /** The real measured testnet USDG (assay-evm `docs/chain-facts.md`). */
    asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
    /**
     * Distinct from `escrow` for the same reason every other pair here is: the
     * proxy and the implementation behind it are the two halves of the ERC-1967
     * control check, and a fixture that made them equal would pass a check that
     * compared the proxy with itself.
     */
    escrowImplementation: '0x8888888888888888888888888888888888888888',
    admin: '0x9999999999999999999999999999999999999999',
  },
  [CHAIN_IDS.BASE_SEPOLIA]: {
    config: '0x4444444444444444444444444444444444444444',
    stake: '0x5555555555555555555555555555555555555555',
    escrow: '0x6666666666666666666666666666666666666666',
    asset: '0x7777777777777777777777777777777777777777',
    escrowImplementation: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    admin: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
};

export function deployment(chainId: ChainId): EvmDeployment {
  const addresses = ADDRESSES[chainId];
  if (!addresses) {
    throw new Error(`no fixture deployment for ${chainId}`);
  }
  return { chainId, ...addresses };
}

/**
 * A key pair, its address, and a signing function — built on `@noble/curves`
 * **directly**, never through the adapter or through viem.
 *
 * Independence is the whole point. Every negative in the behaviour specs needs
 * a signature that is genuinely valid and genuinely somebody else's, and a
 * helper that reached for the adapter's own encoder would make each of those
 * cases a consistency check with itself — the exact shape
 * `chain-adapter.contract.ts` is stuck with and the behaviour specs exist to
 * escape.
 */
export interface EvmSigner {
  readonly privateKey: `0x${string}`;
  readonly address: `0x${string}`;
  readonly account: AccountId;
  /** `r || s || v` over a 32-byte digest, with `v` in {27, 28}. */
  readonly sign: (digest: Uint8Array) => string;
}

export function generateSigner(chainId: ChainId): EvmSigner {
  const bytes = secp256k1.utils.randomPrivateKey();
  const address = getAddress(
    `0x${keccak256(secp256k1.getPublicKey(bytes, false).subarray(1)).slice(-40)}`,
  );
  return {
    privateKey: `0x${Buffer.from(bytes).toString('hex')}` as `0x${string}`,
    address,
    account: `${chainId}:${address}` as AccountId,
    sign: (digest) => {
      const signature = secp256k1.sign(digest, bytes);
      return `0x${signature.toCompactHex()}${(27 + signature.recovery).toString(16).padStart(2, '0')}`;
    },
  };
}

/** The same signer, re-addressed onto another chain. One key, every EVM chain. */
export function onChain(signer: EvmSigner, chainId: ChainId): EvmSigner {
  return { ...signer, account: `${chainId}:${signer.address}` as AccountId };
}

/**
 * A serialized, signed `depositFor` transaction — the bytes a buyer submits.
 *
 * Shared rather than written twice, because the binding it carries is asserted
 * from two directions: `evm-chain.adapter.x402.spec.ts` mutates each field to
 * show the adapter reads it, and `evm-chain.adapter.spec.ts` uses an unmutated
 * one to show that a payload the adapter accepts is a payload it read out of
 * SIGNED bytes rather than out of a claim beside them.
 *
 * The `(r, s, v)` are constants, not a real signature: nothing in
 * `assertPayloadBoundToIntent` recovers a signer, and it must not — what binds
 * the payment is what the transaction DOES, and a transaction that is not
 * genuinely signed simply never lands.
 */
export function depositTransaction(
  overrides: {
    to?: string;
    buyer?: string;
    amount?: bigint;
    chainId?: number;
    data?: `0x${string}`;
  } = {},
): `0x${string}` {
  return serializeTransaction(
    {
      type: 'eip1559',
      chainId: overrides.chainId ?? 46_630,
      to: (overrides.to ?? deployment(CHAIN_IDS.ROBINHOOD_TESTNET).escrow) as `0x${string}`,
      value: 0n,
      nonce: 3,
      gas: 120_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1n,
      data:
        overrides.data ??
        encodeFunctionData({
          abi: X402_ESCROW_ABI,
          functionName: 'depositFor',
          args: [
            (overrides.buyer ?? '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4') as `0x${string}`,
            overrides.amount ?? 10_000n,
          ],
        }),
    },
    { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 27n },
  );
}
