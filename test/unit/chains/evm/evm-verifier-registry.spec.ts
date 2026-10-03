import { secp256k1 } from '@noble/curves/secp256k1';
import { getAddress, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import { EvmVerifierRegistryService } from '@modules/chains/evm/evm-verifier-registry.service';
import { EvmReadClient } from '@modules/chains/evm/evm-chain.adapter';
import { RegisteredVerifierStatus } from '@modules/verification/signing/ports/verifier-registry.port';

/**
 * `X402Config.verifierKey`, read through the port.
 *
 * Two things this suite has to hold that a happy-path test would not:
 *
 * - **`registered: false` is `null`, never `REVOKED`.** Solidity returns a
 *   zero-valued struct for a mapping key nobody wrote, so never-enrolled and
 *   enrolled-then-revoked arrive as the same shape and differ only by
 *   `registered`. They mean different things to an operator.
 * - **the address derivation drops the `0x04` prefix.** Hashing it too yields a
 *   perfectly well-formed address belonging to nobody, and the failure surfaces
 *   as `SignerIsNotVerifier` against a key that was fine.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const CONFIG = '0x1111111111111111111111111111111111111111' as const;

/** A fixed key, so the expected address is a constant this file did not compute. */
const SCALAR = toBytes('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const PUBLIC_KEY = secp256k1.getPublicKey(SCALAR, false);
/**
 * Pinned as a literal, and cross-checked against viem's `privateKeyToAccount`
 * — a genuinely different code path from the `keccak(pubkey[1:])[-20:]` under
 * test, which is what keeps this from being the `===`-asserts-`===` shape.
 * Both are asserted: the literal catches a change to viem, viem catches a
 * literal transcribed wrong.
 */
const EXPECTED_ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

describe('EvmVerifierRegistryService', () => {
  it('renders the uncompressed key as its EIP-55 address', () => {
    const { registry } = build();

    expect(registry.addressOf(TESTNET, PUBLIC_KEY)).toBe(EXPECTED_ADDRESS);
    // The independent source.
    expect(privateKeyToAccount(`0x${Buffer.from(SCALAR).toString('hex')}`).address).toBe(
      EXPECTED_ADDRESS,
    );
  });

  it('hashes X||Y and not the 0x04 prefix', () => {
    // The off-by-one control. Hashing all 65 bytes produces a different,
    // equally well-formed address — so "it returned an address" proves nothing
    // and this names the wrong one explicitly.
    const wrong = getAddress(`0x${keccak256(PUBLIC_KEY).slice(-40)}`);

    expect(wrong).not.toBe(EXPECTED_ADDRESS);
    expect(build().registry.addressOf(TESTNET, PUBLIC_KEY)).not.toBe(wrong);
  });

  it('refuses anything that is not a 65-byte uncompressed key', () => {
    const { registry } = build();

    expect(() => registry.addressOf(TESTNET, secp256k1.getPublicKey(SCALAR, true))).toThrow(
      /65-byte uncompressed/,
    );
    // An ed25519 public key is 32 bytes and would otherwise be hashed into a
    // plausible-looking address for a key that cannot sign on this chain.
    expect(() => registry.addressOf(TESTNET, new Uint8Array(32))).toThrow(/65-byte uncompressed/);
    // 65 bytes with the wrong prefix: a compressed key padded, or a raw X||Y
    // with a leading byte that is not 0x04.
    const badPrefix = Uint8Array.from(PUBLIC_KEY);
    badPrefix[0] = 0x03;
    expect(() => registry.addressOf(TESTNET, badPrefix)).toThrow(/65-byte uncompressed/);
  });

  it('refuses a solana chain rather than answering for it', async () => {
    const { registry } = build();

    expect(() => registry.addressOf(CHAIN_IDS.SOLANA_DEVNET, PUBLIC_KEY)).toThrow(
      /No chain adapter is enabled for solana/,
    );
    await expect(registry.lookup(CHAIN_IDS.SOLANA_DEVNET, PUBLIC_KEY)).rejects.toThrow(
      /No chain adapter is enabled for solana/,
    );
  });

  it('decodes a live registration field by field, and asks the config contract', async () => {
    const { registry, reads } = build({
      registeredAt: 1_760_000_000n,
      expiresAt: 1_775_552_000n,
      revokedAt: 0n,
      registered: true,
      revoked: false,
    });

    await expect(registry.lookup(TESTNET, PUBLIC_KEY)).resolves.toEqual({
      address: EXPECTED_ADDRESS,
      status: RegisteredVerifierStatus.ACTIVE,
      label: '',
      registeredAt: new Date(1_760_000_000_000),
      expiresAt: new Date(1_775_552_000_000),
      // `revokedAt` is 0 on a live key, and `new Date(0)` is a date somebody
      // could format and print. `null` is the absence the port asks for.
      revokedAt: null,
    });
    expect(reads).toEqual([
      { address: CONFIG, functionName: 'verifierKey', args: [EXPECTED_ADDRESS] },
    ]);
  });

  it('reports REVOKED with its timestamp when the key was revoked', async () => {
    const { registry } = build({
      registeredAt: 1_760_000_000n,
      expiresAt: 1_775_552_000n,
      revokedAt: 1_761_000_000n,
      registered: true,
      revoked: true,
    });

    await expect(registry.lookup(TESTNET, PUBLIC_KEY)).resolves.toEqual(
      expect.objectContaining({
        status: RegisteredVerifierStatus.REVOKED,
        revokedAt: new Date(1_761_000_000_000),
      }),
    );
  });

  it('returns null — not REVOKED — for a key that was never registered', async () => {
    // The zero-valued struct Solidity hands back for a key nobody wrote. Every
    // field is falsy, so a reader that keyed off `revoked` alone would call
    // this ACTIVE, and one that keyed off "not active" would call it REVOKED.
    const { registry } = build({
      registeredAt: 0n,
      expiresAt: 0n,
      revokedAt: 0n,
      registered: false,
      revoked: false,
    });

    await expect(registry.lookup(TESTNET, PUBLIC_KEY)).resolves.toBeNull();
  });

  it('exposes no way to enrol, renew or revoke a verifier', () => {
    // A verifier address is one-shot in BOTH directions — after a revoke and
    // after a plain expiry — so rotation is always a new address and there is
    // no renew to offer. And enrolment is the admin Ledger's: a process that
    // could both sign and enrol would be enough, on its own, to slash every
    // provider.
    const surface = [
      ...Object.getOwnPropertyNames(build().registry),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(build().registry)),
    ];

    for (const forbidden of [
      'register',
      'registerVerifier',
      'revoke',
      'revokeVerifier',
      'renew',
      'extend',
      'reRegister',
      'updateConfig',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });
});

interface OnChainKey {
  registeredAt: bigint;
  expiresAt: bigint;
  revokedAt: bigint;
  registered: boolean;
  revoked: boolean;
}

function build(key?: OnChainKey) {
  const reads: Array<{ address: string; functionName: string; args: readonly unknown[] }> = [];
  const client: EvmReadClient = {
    getTransactionReceipt: async () => null,
    getBlock: async () => ({ number: 1n }),
    readContract: async (args) => {
      reads.push({ address: args.address, functionName: args.functionName, args: args.args });
      return key;
    },
  };
  const deployment: EvmDeployment = {
    chainId: TESTNET,
    config: CONFIG,
    stake: '0x2222222222222222222222222222222222222222',
    escrow: '0x3333333333333333333333333333333333333333',
    asset: '0x915Ef7c9F9f80a69e3BE47A38EE0Bb47607103ec',
    // Both are fields of `EvmDeployment`; neither is read on this path.
    escrowImplementation: '0x8888888888888888888888888888888888888888',
    admin: '0x9999999999999999999999999999999999999999',
  };
  const registry = new EvmVerifierRegistryService(
    new Map<ChainId, EvmReadClient>([[TESTNET, client]]),
    new Map<ChainId, EvmDeployment>([[TESTNET, deployment]]),
  );
  return { registry, reads };
}
