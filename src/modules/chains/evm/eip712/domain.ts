import { TypedDataDomain } from 'viem';

import { ChainId, ChainNamespace, parseChainId } from '../../ports/caip.types';

/** `"Assay Settlement"` — identical on `AssayEscrow` and `AssayStake`. */
export const EVM_DOMAIN_NAME = 'Assay Settlement';

/**
 * `"2"`.
 *
 * A v3 layout ships as `version: "3"`, and every v2 signature stops verifying
 * the moment it does — which is the intended behaviour, not a migration
 * problem: a signature over a struct that has been redefined is a signature
 * over something the signer never saw.
 */
export const EVM_DOMAIN_VERSION = '2';

/**
 * The EIP-712 domain. No `salt`; three fields do real work.
 *
 * `chainId` is the one that matters most. The same key controls the same
 * address on every EVM chain, so without it a voucher signed for a testnet
 * escrow verifies against the mainnet escrow of the same buyer.
 *
 * `verifyingContract` closes cross-contract replay — `AssayEscrow` and
 * `AssayStake` share the name and version, and this field is the only thing
 * separating them — and makes a redeploy invalidate every outstanding voucher
 * automatically. It is the **proxy** address, which does not move across
 * an upgrade.
 *
 * The namespace check is not decoration. `parseChainId('solana:5eykt…')`
 * returns a base58 genesis hash as its reference; `Number()` of that is `NaN`,
 * `NaN` encodes as zero, and a domain with `chainId: 0` is a domain every EVM
 * chain agrees with. Refusing is the only safe answer.
 */
export function evmDomain(chainId: ChainId, verifyingContract: `0x${string}`): TypedDataDomain {
  const { namespace, reference } = parseChainId(chainId);
  if (namespace !== ChainNamespace.EIP155) {
    throw new Error(`evmDomain called with a ${namespace} chain id`);
  }
  return {
    name: EVM_DOMAIN_NAME,
    version: EVM_DOMAIN_VERSION,
    chainId: Number(reference),
    verifyingContract,
  };
}
