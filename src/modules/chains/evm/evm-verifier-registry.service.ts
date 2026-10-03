import { getAddress, keccak256 } from 'viem';

import {
  RegisteredVerifierStatus,
  VerifierRegistryEntry,
  VerifierRegistryPort,
} from '@modules/verification/signing/ports/verifier-registry.port';

import { ChainErrors } from '../errors/chains.errors';
import { ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { X402_CONFIG_ABI } from './abi/x402.abi';
import { EvmReadClient } from './evm-chain.adapter';
import { EvmDeployment } from './evm.constants';

/** The five fields `X402Config.verifierKey` returns. Names pinned by the ABI. */
interface OnChainVerifierKey {
  readonly registeredAt: bigint;
  readonly expiresAt: bigint;
  readonly revokedAt: bigint;
  readonly registered: boolean;
  readonly revoked: boolean;
}

/**
 * `X402Config`'s verifier allowlist, read-only.
 *
 * The eip155 half of `VerifierRegistryPort`. Everything that port's own comment
 * says about being read-only holds here and for the same reason:
 * `registerVerifier` and `revokeVerifier` are `X402Config`'s admin doors, run
 * by a human under the admin Ledger, and are deliberately absent from
 * `X402_CONFIG_ABI` so that no call site in this codebase can reach one. If the
 * process that holds the *signing* key could also enrol keys, compromising it
 * would be enough to mint a verifier and slash every provider.
 *
 * ## There is no re-enrolment, and there is no method here that pretends there is
 *
 * A verifier address is **one-shot in both directions**. After `revokeVerifier`
 * the address can never be registered again — and after a plain expiry it
 * cannot either, which is the half people forget, because nothing *happened*.
 * So rotation is always a **new address**, there is no "renew key" to offer,
 * and any future method called `renew`, `extend` or `reRegister` on this class
 * would be describing an operation the contract does not have.
 *
 * ## `registered: false` is `null`, not `REVOKED`
 *
 * Solidity returns a zero-valued struct for a mapping key that was never
 * written, so "never enrolled" and "enrolled then revoked" arrive as the same
 * *shape* and are told apart only by `registered`. The port's two answers mean
 * different things to an operator — never-registered is a deployment set up
 * wrong, revoked is an incident — so they must not be collapsed here, where the
 * distinction is still available.
 */
export class EvmVerifierRegistryService implements VerifierRegistryPort {
  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReadClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
  ) {}

  /**
   * The 65-byte uncompressed SEC1 key → its EIP-55 address.
   *
   * `keccak` of `X || Y` — the key **without** its `0x04` prefix — last 20
   * bytes, checksummed. Hashing the prefix too is the classic off-by-one here
   * and it yields a perfectly well-formed address belonging to nobody, which
   * then reads as `SignerIsNotVerifier` against a key that was fine.
   */
  addressOf(chainId: ChainId, publicKey: Uint8Array): string {
    this.assertEip155(chainId);
    if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
      throw ChainErrors.invalidAddress({
        address: `<${publicKey.length}-byte key>`,
        chainId: 'an eip155 verifier key is a 65-byte uncompressed secp256k1 key (0x04 || X || Y)',
      });
    }
    return getAddress(`0x${keccak256(publicKey.subarray(1)).slice(-40)}`);
  }

  async lookup(chainId: ChainId, publicKey: Uint8Array): Promise<VerifierRegistryEntry | null> {
    const address = this.addressOf(chainId, publicKey);
    const deployment = this.deploymentFor(chainId);

    const key = (await this.clientFor(chainId).readContract({
      address: deployment.config,
      abi: X402_CONFIG_ABI,
      functionName: 'verifierKey',
      args: [address],
    })) as OnChainVerifierKey;

    if (!key.registered) {
      return null;
    }

    return {
      address,
      status: key.revoked ? RegisteredVerifierStatus.REVOKED : RegisteredVerifierStatus.ACTIVE,
      // `X402Config` stores no label. Empty rather than invented: the caller's
      // own `keyId` is the name it already has, and a label derived here would
      // read like something the chain said.
      label: '',
      registeredAt: secondsToDate(key.registeredAt),
      expiresAt: secondsToDate(key.expiresAt),
      // `revokedAt` is 0 on a live key, and `new Date(0)` is 1970 — a date, and
      // therefore something a caller could format and print. `null` is the
      // absence the port asks for.
      revokedAt: key.revoked ? secondsToDate(key.revokedAt) : null,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Refuse a chain this service does not serve.
   *
   * `ChainVerifierRegistry` dispatches by namespace and would not route a
   * `solana:` lookup here — which is why this exists. The multiplexer is a
   * table, a table can be wired wrong, and a registry that answered for the
   * wrong namespace would report a key as enrolled on the strength of somebody
   * else's chain.
   */
  private assertEip155(chainId: ChainId): void {
    if (namespaceOf(chainId) !== ChainNamespace.EIP155) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
  }

  private deploymentFor(chainId: ChainId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) {
      throw ChainErrors.programNotConfigured({
        what: `the X402Config deployment on ${chainId}`,
        variable: 'EVM_DEPLOYMENTS',
      });
    }
    return deployment;
  }

  private clientFor(chainId: ChainId): EvmReadClient {
    const client = this.clients.get(chainId);
    if (!client) {
      throw ChainErrors.programNotConfigured({
        what: `a JSON-RPC client for ${chainId}`,
        variable: 'EVM_RPC_URLS',
      });
    }
    return client;
  }
}

/** `uint64` seconds → `Date`. Safe: 2^64 seconds overflows, 2^53 does not, and
 * the contract's own timestamps are block times. */
function secondsToDate(seconds: bigint): Date {
  return new Date(Number(seconds) * 1000);
}
