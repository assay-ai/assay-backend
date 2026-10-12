import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { SigningKeyState } from '@modules/verification/signing/domain/key-lifecycle';
import { SignerBackend, SignerKeyHandle } from '@modules/verification/signing/ports/signer.port';
import {
  RegisteredVerifierStatus,
  VerifierRegistryEntry,
} from '@modules/verification/signing/ports/verifier-registry.port';
import { VerifierKeyDirectory } from '@modules/verification/signing/services/verifier-key-directory.service';

/**
 * The directory resolves the key **for a chain**, and refuses one that
 * cannot sign for it.
 *
 * Before multichain support this class had no spec at all, and with one chain it did not need
 * one: `findActive()` returned the only row there could be. The three things
 * below are new and each is a way the two-chain version fails silently.
 */
const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;

describe('VerifierKeyDirectory.resolveSignableKey', () => {
  it('resolves the ACTIVE key of the chain it was asked for', async () => {
    const { directory, keys } = build();

    const resolved = await directory.resolveSignableKey(EVM);

    expect(resolved.handle.keyId).toBe('verifier-evm-2026-09');
    expect(resolved.handle.curve).toBe('secp256k1');
    // The row query is per chain, not "the active key" filtered afterwards. A
    // directory that read every ACTIVE row and picked one would return a
    // different key depending on insertion order.
    expect(keys.findActive).toHaveBeenCalledWith(EVM);
  });

  it('refuses an ed25519 key for an eip155 chain, naming both curves', async () => {
    // The gate. A 64-byte ed25519 signature is not malformed to `ecrecover` —
    // it reads as a well-formed signature belonging to a stranger, the contract
    // answers `VerifierNotRegistered`, and the investigation starts at the
    // registry instead of at the misrouted key.
    //
    // The fixture violates EXACTLY one thing: the row says EVM, the handle is
    // ed25519, and everything else (state, registry entry, expiry, the chain
    // pin — which is null on this backend) is as the passing case.
    const { directory } = build({
      rows: { [EVM]: row({ keyId: 'wrong-curve', chainId: EVM }) },
      handles: { 'wrong-curve': handle({ keyId: 'wrong-curve', curve: 'ed25519', chainId: null }) },
    });

    await expect(directory.resolveSignableKey(EVM)).rejects.toThrow(
      /verifies secp256k1, and this key is ed25519/,
    );
  });

  it('refuses a secp256k1 key for a solana chain — the same gate, other way round', async () => {
    const { directory } = build({
      rows: { [SOLANA]: row({ keyId: 'wrong-curve', chainId: SOLANA }) },
      handles: {
        'wrong-curve': handle({ keyId: 'wrong-curve', curve: 'secp256k1', chainId: null }),
      },
    });

    await expect(directory.resolveSignableKey(SOLANA)).rejects.toThrow(
      /verifies ed25519, and this key is secp256k1/,
    );
  });

  it('refuses when the backend pins the key to a DIFFERENT chain of the same curve', async () => {
    // The curve check cannot see this one: both chains are eip155, so both
    // want secp256k1. What differs is which chain the custody backend says the
    // material was provisioned for — and signing a 46630 attestation with a
    // 4663 key produces a signature that verifies against the wrong contract.
    const OTHER_EVM = CHAIN_IDS.ROBINHOOD_MAINNET;
    const { directory } = build({
      rows: { [EVM]: row({ keyId: 'pinned-elsewhere', chainId: EVM }) },
      handles: {
        'pinned-elsewhere': handle({
          keyId: 'pinned-elsewhere',
          curve: 'secp256k1',
          chainId: OTHER_EVM,
        }),
      },
    });

    await expect(directory.resolveSignableKey(EVM)).rejects.toThrow(
      /the directory names eip155:46630, the custody backend names eip155:4663/,
    );
  });

  it('accepts a backend that pins nothing — the positive control for the pin check', async () => {
    // `VERIFIER_SIGNING_KEYS` has shipped as `{ keyId, secretKey }` and names no
    // chain, so `handle.chainId` is null there. That must not be read as a
    // mismatch, or every existing deployment stops signing on upgrade.
    const { directory } = build({
      rows: { [SOLANA]: row({ keyId: 'unpinned', chainId: SOLANA }) },
      handles: { unpinned: handle({ keyId: 'unpinned', curve: 'ed25519', chainId: null }) },
    });

    await expect(directory.resolveSignableKey(SOLANA)).resolves.toEqual(
      expect.objectContaining({ handle: expect.objectContaining({ keyId: 'unpinned' }) }),
    );
  });

  it('names the chain when no key is active for it, while another chain has one', async () => {
    // Without the chain in the message this reads as "attestation issuance is
    // halted" on a deployment where it is halted on ONE chain.
    const { directory } = build({
      rows: { [SOLANA]: row({ keyId: 'verifier-solana-2026-09', chainId: SOLANA }) },
      handles: {
        'verifier-solana-2026-09': handle({ keyId: 'verifier-solana-2026-09', chainId: SOLANA }),
      },
    });

    await expect(directory.resolveSignableKey(EVM)).rejects.toThrow(/eip155:46630/);
    await expect(directory.resolveSignableKey(SOLANA)).resolves.toBeDefined();
  });

  it('refuses when no custody backend holds the chain’s curve', async () => {
    // A deployment serving eip155 without `EVM_VERIFIER_SIGNING_KEYS`. The
    // honest answer is "there is no secp256k1 backend", not "no such key" from
    // a backend that was never going to have it.
    const { directory, signers } = build();
    signers.delete('secp256k1');

    await expect(directory.resolveSignableKey(EVM)).rejects.toThrow(
      /verifies secp256k1 and no secp256k1 custody backend is bound/,
    );
    // The positive control: the other chain still signs.
    await expect(directory.resolveSignableKey(SOLANA)).resolves.toBeDefined();
  });

  it('hands back the backend it resolved, so nothing resolves a second one', async () => {
    const { directory, signers } = build();
    const evmSigner = { getKey: jest.fn(async () => handleFor('verifier-evm-2026-09')) };
    signers.set('secp256k1', evmSigner as never);

    const resolved = await directory.resolveSignableKey(EVM);

    expect(resolved.signer).toBe(evmSigner);
    expect(evmSigner.getKey).toHaveBeenCalledWith('verifier-evm-2026-09');
  });

  it('asks the registry about the chain it was asked about', async () => {
    const { directory, registry } = build();

    await directory.resolveSignableKey(EVM);

    expect(registry.addressOf).toHaveBeenCalledWith(EVM, expect.any(Uint8Array));
    expect(registry.lookup).toHaveBeenCalledWith(EVM, expect.any(Uint8Array));
  });

  it('caches per chain, so one chain does not evict the other', async () => {
    // The cache was a single slot keyed by address. With two chains that is not
    // a smaller cache but a wrong one: each lookup evicted the other's entry,
    // so the hit rate went to zero and every signature waited on an RPC round
    // trip — correct, silent, and slow.
    const { directory, registry } = build();

    await directory.resolveSignableKey(SOLANA);
    await directory.resolveSignableKey(EVM);
    await directory.resolveSignableKey(SOLANA);
    await directory.resolveSignableKey(EVM);

    // Two cold reads, then two hits. Four means the cache never held anything.
    expect(registry.lookup).toHaveBeenCalledTimes(2);
  });

  it('drops every chain’s cache when a rotation says to', async () => {
    const { directory, registry } = build();
    await directory.resolveSignableKey(SOLANA);
    await directory.resolveSignableKey(EVM);

    directory.forgetRegistryCache();
    await directory.resolveSignableKey(SOLANA);
    await directory.resolveSignableKey(EVM);

    expect(registry.lookup).toHaveBeenCalledTimes(4);
  });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function handleFor(keyId: string): SignerKeyHandle {
  return handle({
    keyId,
    curve: 'secp256k1',
    chainId: EVM,
    publicKey: new Uint8Array(65).fill(4),
  });
}

function row(overrides: { keyId?: string; chainId: ChainId; state?: SigningKeyState }) {
  return {
    keyId: overrides.keyId ?? `verifier-${overrides.chainId}`,
    chainId: overrides.chainId,
    state: overrides.state ?? SigningKeyState.ACTIVE,
  };
}

function handle(overrides: Partial<SignerKeyHandle> & { keyId: string }): SignerKeyHandle {
  return {
    backend: SignerBackend.ENV,
    backendRef: 'env:TEST',
    publicKey: new Uint8Array(32).fill(7),
    curve: 'ed25519',
    chainId: null,
    ...overrides,
  };
}

function registryEntry(): VerifierRegistryEntry {
  return {
    address: 'the-address',
    status: RegisteredVerifierStatus.ACTIVE,
    label: '',
    registeredAt: new Date('2026-01-01T00:00:00Z'),
    // Far enough out that `warnIfExpiringSoon` stays quiet and no test depends
    // on the alert fake.
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    revokedAt: null,
  };
}

function build(
  options: {
    rows?: Record<string, ReturnType<typeof row>>;
    handles?: Record<string, SignerKeyHandle>;
  } = {},
) {
  const rows = options.rows ?? {
    [SOLANA]: row({ keyId: 'verifier-solana-2026-09', chainId: SOLANA }),
    [EVM]: row({ keyId: 'verifier-evm-2026-09', chainId: EVM }),
  };
  const handles = options.handles ?? {
    'verifier-solana-2026-09': handle({ keyId: 'verifier-solana-2026-09', chainId: SOLANA }),
    'verifier-evm-2026-09': handle({
      keyId: 'verifier-evm-2026-09',
      curve: 'secp256k1',
      chainId: EVM,
      publicKey: new Uint8Array(65).fill(4),
    }),
  };

  const keys = {
    findActive: jest.fn(async (chainId: ChainId) => rows[chainId] ?? null),
  };
  const signer = {
    getKey: jest.fn(async (keyId: string) => {
      const found = handles[keyId];
      if (!found) throw new Error(`no such key ${keyId}`);
      return found;
    }),
  };
  const registry = {
    addressOf: jest.fn(
      (chainId: ChainId, publicKey: Uint8Array) => `${chainId}:${publicKey.length}`,
    ),
    lookup: jest.fn(async () => registryEntry()),
  };
  const alerts = { emit: jest.fn(async () => undefined) };

  // The backend is chosen by CURVE, so the fixture supplies both and a
  // test that resolved through the wrong one would fail on `getKey`.
  const signers = new Map([
    ['ed25519', signer],
    ['secp256k1', signer],
  ]);

  const directory = new VerifierKeyDirectory(
    signers as never,
    registry as never,
    alerts as never,
    { registryCacheMs: 60_000, expiryWarningMs: 1_000 } as never,
    keys as never,
  );

  return { directory, keys, signer, signers, registry, alerts };
}
