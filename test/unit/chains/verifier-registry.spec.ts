import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

import { SETTLEMENT_PROGRAM_ID } from '@modules/chains/solana/settlement-program.constants';
import {
  SolanaVerifierRegistryService,
  VerifierRegistryRpcClient,
} from '@modules/chains/solana/verifier-registry.service';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { RegisteredVerifierStatus } from '@modules/verification/signing/ports/verifier-registry.port';

/**
 * The `VerifierKey` reader.
 *
 * The decoding itself is `@assay/settlement-client`, generated from the
 * program's IDL, so the offsets are no longer this repo's to get wrong. What
 * these tests pin is everything the generated decoder does *not* decide: that a
 * never-registered key is `null` rather than an error, that the discriminator is
 * checked rather than skipped, that `revoked_at = 0` is "never" rather than
 * 1970, and that anything which is not a well-formed `VerifierKey` is refused
 * loudly instead of being read as an allowlist entry.
 *
 * The fixtures below still lay the account out byte by byte on purpose. Building
 * them with the generated *encoder* would make the suite tautological — encoder
 * and decoder would agree about a wrong layout just as readily as a right one.
 * These bytes are written from `state.rs`, so they are an independent statement
 * of what the program stores.
 *
 * The **seeds** are cross-checked elsewhere and deliberately not here: the
 * devnet rotation drill registers a key using the address derived by this code,
 * and the program derives the same PDA itself under an `init` constraint. A
 * mismatch fails that transaction with `ConstraintSeeds`, which is a stronger
 * check than pinning a hard-coded string that both sides could drift from
 * together.
 */
describe('SolanaVerifierRegistryService', () => {
  /** Every method takes the chain it is asking about. */
  const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
  const PROGRAM_ID = '7C4i9t4sHpMpsqsB91JYBmuvNfnbof2DPN1yZp3KjN2S';
  const VERIFIER = 'BPFLoaderUpgradeab1e11111111111111111111111';
  const REGISTERED_AT = 1_760_000_000;
  /** `sha256("account:VerifierKey")[..8]`, from the program's IDL. */
  const VERIFIER_KEY_DISCRIMINATOR = Buffer.from([27, 40, 233, 33, 249, 246, 9, 239]);
  const EXPIRES_AT = REGISTERED_AT + 180 * 86_400;

  it('renders a raw ed25519 public key as a base58 address', () => {
    const service = build(null);
    const bytes = new Uint8Array(getAddressEncoder().encode(address(VERIFIER)));

    expect(service.addressOf(SOLANA, bytes)).toBe(VERIFIER);
  });

  it('refuses a public key that is not 32 bytes', () => {
    // A 64-byte solana-keygen array pasted where a public key belongs would
    // otherwise base58-encode into a plausible-looking string.
    expect(() => build(null).addressOf(SOLANA, new Uint8Array(64))).toThrow(
      /not valid on this chain/,
    );
  });

  it('returns null for a key that was never registered', async () => {
    // Distinct from REVOKED, and callers must keep them apart: never-registered
    // is a misconfigured deployment, revoked is an incident.
    await expect(build(null).lookup(SOLANA, publicKeyBytes())).resolves.toBeNull();
  });

  it('decodes an active entry field by field', async () => {
    const entry = await build(account({ status: 0 })).lookup(SOLANA, publicKeyBytes());

    expect(entry).toEqual({
      address: VERIFIER,
      status: RegisteredVerifierStatus.ACTIVE,
      label: 'verifier-2026-08',
      registeredAt: new Date(REGISTERED_AT * 1000),
      expiresAt: new Date(EXPIRES_AT * 1000),
      revokedAt: null,
    });
  });

  it('decodes a revoked entry, including when it was revoked', async () => {
    const revokedAt = REGISTERED_AT + 86_400;
    const entry = await build(account({ status: 1, revokedAt })).lookup(SOLANA, publicKeyBytes());

    expect(entry?.status).toBe(RegisteredVerifierStatus.REVOKED);
    expect(entry?.revokedAt).toEqual(new Date(revokedAt * 1000));
  });

  it('reads revoked_at = 0 as "never revoked" rather than as 1970', async () => {
    const entry = await build(account({ status: 0, revokedAt: 0 })).lookup(
      SOLANA,
      publicKeyBytes(),
    );

    expect(entry?.revokedAt).toBeNull();
  });

  it('refuses an account of the wrong length instead of reading past a field', async () => {
    // The program was upgraded and this decoder was not. Loud, because the
    // quiet version of this bug authorises the wrong signing key.
    const short = account({ status: 0 }).subarray(0, 90);

    await expect(build(short).lookup(SOLANA, publicKeyBytes())).rejects.toThrow(
      /does not match the expected layout/,
    );
  });

  it('refuses an account that is not a VerifierKey, rather than reinterpreting it', async () => {
    // A PDA is just an address. If the program ever grows a second account type
    // at these seeds, skipping the discriminator would read it as an allowlist
    // entry — which is a way to authorise a signing key by accident.
    const wrongType = account({ status: 0 });
    wrongType.set(Buffer.from([155, 12, 170, 224, 30, 250, 204, 130]), 0); // Config

    await expect(build(wrongType).lookup(SOLANA, publicKeyBytes())).rejects.toThrow(
      /expected a VerifierKey account/,
    );
  });

  it('refuses a status byte it does not recognise', async () => {
    // A third variant must not read as "active" and must not read as "revoked".
    // The generated enum decoder is what refuses it; the assertion is on the
    // reason surviving into the domain error, because "status 2" is the whole
    // content of this failure and a bare "layout unexpected" would send the
    // reader to the offsets instead.
    await expect(build(account({ status: 2 })).lookup(SOLANA, publicKeyBytes())).rejects.toThrow(
      /Enum discriminator out of range.*got 2/,
    );
  });

  it('refuses an account whose stored verifier is not the key that was asked about', async () => {
    const other = new Uint8Array(getAddressEncoder().encode(address(PROGRAM_ID)));
    await expect(
      build(account({ status: 0, verifier: other })).lookup(SOLANA, publicKeyBytes()),
    ).rejects.toThrow(/does not match the expected layout/);
  });

  it('says which variable to set when no program id is configured', async () => {
    const service = new SolanaVerifierRegistryService(rpc(null), null);

    await expect(service.lookup(SOLANA, publicKeyBytes())).rejects.toThrow(
      /SOLANA_SETTLEMENT_PROGRAM_ID/,
    );
  });

  it('derives the PDA from the seeds the program declares', async () => {
    // Not a pinned constant — the same derivation the service does, asserted to
    // be reachable and stable. What proves it matches the program is the drill.
    const [pda] = await getProgramDerivedAddress({
      programAddress: address(PROGRAM_ID),
      seeds: [
        new Uint8Array(Buffer.from('verifier', 'utf8')),
        getAddressEncoder().encode(address(VERIFIER)),
      ],
    });
    let requested: string | null = null;
    const service = new SolanaVerifierRegistryService(
      {
        getAccountInfo: (addr) => {
          requested = addr;
          return { send: async () => ({ value: null }) };
        },
      },
      PROGRAM_ID,
    );

    await service.lookup(SOLANA, publicKeyBytes());

    expect(requested).toBe(pda);
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  function publicKeyBytes(): Uint8Array {
    return new Uint8Array(getAddressEncoder().encode(address(VERIFIER)));
  }

  /**
   * `VerifierKey` exactly as `state.rs` lays it out. See the service for the table.
   *
   * Lean v3 removed `active_from` — it sat between `registered_at` and
   * `expires_at` — so the account is 114 bytes and every offset from 81 on
   * moved back by eight. Written out from the Rust struct rather than derived
   * from the generated encoder, for the reason in this file's header: an
   * encoder and a decoder agree about a wrong layout exactly as readily as
   * about a right one.
   */
  function account(fields: {
    status: number;
    revokedAt?: number;
    verifier?: Uint8Array;
  }): Uint8Array {
    const data = new Uint8Array(114);
    const view = new DataView(data.buffer);
    data.set(VERIFIER_KEY_DISCRIMINATOR, 0);
    data.set(fields.verifier ?? publicKeyBytes(), 8);
    data[40] = fields.status;
    data.set(Buffer.from('verifier-2026-08', 'utf8'), 41); // [u8; 32], NUL-padded
    view.setBigInt64(73, BigInt(REGISTERED_AT), true);
    view.setBigInt64(81, BigInt(EXPIRES_AT), true);
    view.setBigInt64(89, BigInt(fields.revokedAt ?? 0), true);
    view.setBigUint64(97, 0n, true); // slashed_in_window — the per-key rolling cap
    view.setBigInt64(105, 0n, true); // slash_window_started_at
    data[113] = 255; // bump
    return data;
  }

  function rpc(data: Uint8Array | null): VerifierRegistryRpcClient {
    return {
      getAccountInfo: () => ({
        send: async () =>
          data
            ? { value: { data: [Buffer.from(data).toString('base64'), 'base64'] as const } }
            : { value: null },
      }),
    };
  }

  function build(data: Uint8Array | null): SolanaVerifierRegistryService {
    return new SolanaVerifierRegistryService(rpc(data), PROGRAM_ID);
  }
});

// Referenced so the token's name stays in step with the provider that supplies it.
void SETTLEMENT_PROGRAM_ID;

describe('SolanaVerifierRegistryService refuses a chain it does not serve', () => {
  /**
   * The multiplexer would never route an `eip155` lookup here — which is why
   * this exists. `ChainVerifierRegistry` is a TABLE, and a table can be wired
   * wrong; a registry that answered for the wrong namespace would report a key
   * as enrolled on the strength of somebody else's chain, and the read would
   * look successful.
   */
  const service = new SolanaVerifierRegistryService(
    { getAccountInfo: () => ({ send: async () => ({ value: null }) }) } as never,
    '7C4i9t4sHpMpsqsB91JYBmuvNfnbof2DPN1yZp3KjN2S',
  );

  it('throws for eip155 rather than decoding an address from it', async () => {
    expect(() => service.addressOf(CHAIN_IDS.ROBINHOOD_TESTNET, new Uint8Array(32))).toThrow(
      /No chain adapter is enabled for eip155/,
    );
    await expect(service.lookup(CHAIN_IDS.ROBINHOOD_TESTNET, new Uint8Array(32))).rejects.toThrow(
      /No chain adapter is enabled for eip155/,
    );
  });

  it('answers for solana — the positive control', () => {
    expect(service.addressOf(CHAIN_IDS.SOLANA_MAINNET, new Uint8Array(32))).toEqual(
      expect.any(String),
    );
  });
});
