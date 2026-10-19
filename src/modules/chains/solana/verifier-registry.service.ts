import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Address,
  address,
  getAddressDecoder,
  getBase64Encoder,
  ReadonlyUint8Array,
} from '@solana/kit';
import {
  findVerifierKeyPda,
  getVerifierKeyDecoder,
  VERIFIER_KEY_DISCRIMINATOR,
  VerifierStatus,
} from '@assay/settlement-client';

import {
  RegisteredVerifierStatus,
  VerifierRegistryEntry,
  VerifierRegistryPort,
} from '@modules/verification/signing/ports/verifier-registry.port';

import { ChainErrors } from '../errors/chains.errors';
import { ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { SOLANA_RPC } from './solana.constants';
import { SETTLEMENT_PROGRAM_ID, SETTLEMENT_PROGRAM_ID_ENV } from './settlement-program.constants';

/** The one RPC call this service makes, declared structurally so a test can supply it. */
export interface VerifierRegistryRpcClient {
  getAccountInfo(
    address: Address,
    config: { encoding: 'base64'; commitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<{ value: { data: readonly [string, 'base64'] } | null }> };
}

/**
 * Reads the settlement program's verifier allowlist.
 *
 * ## Decoded by the generated client, not by hand
 *
 * The seeds, the eight-byte discriminator, the field order and every field's
 * width come from `@assay/settlement-client`, which is Codama output rendered
 * from the program's own IDL. An earlier version of this file did it by hand —
 * ninety lines of `DataView` offsets with the layout written out in a comment —
 * and that was a copy of the program's interface that nothing checked. The
 * account being read here decides who may take a provider's stake; a field read
 * from the wrong offset yields a number that looks like data.
 *
 * What the generated decoder does *not* do is judge whether the bytes it was
 * handed are a `VerifierKey` at all, so the three guards below stay:
 *
 * - the **discriminator**, checked rather than skipped. A PDA is just an
 *   address: if the program ever grows a second account type at these seeds,
 *   decoding without this would reinterpret it as an allowlist entry.
 * - the **stored verifier**, compared against the key whose PDA we derived.
 *   This cannot differ without the program having been changed underneath us,
 *   and the consequence of being wrong is authorising the wrong signing key.
 * - the **status**, which must be one of the two variants the program declares.
 *   An unrecognised third must not read as "revoked" and must not read as
 *   "active".
 *
 * The layout guards that *were* hand-written — length, offsets — are now the
 * decoder's own: `getVerifierKeyDecoder()` is a fixed-size codec and refuses a
 * buffer of the wrong size itself.
 */
@Injectable()
export class SolanaVerifierRegistryService implements VerifierRegistryPort {
  private readonly logger = new Logger(SolanaVerifierRegistryService.name);

  constructor(
    @Inject(SOLANA_RPC) private readonly rpc: VerifierRegistryRpcClient,
    @Inject(SETTLEMENT_PROGRAM_ID) private readonly programId: string | null,
  ) {}

  addressOf(chainId: ChainId, publicKey: Uint8Array): string {
    this.assertSolana(chainId);
    if (publicKey.length !== 32) {
      throw ChainErrors.invalidAddress({
        address: `<${publicKey.length}-byte key>`,
        chainId: 'an ed25519 public key is 32 bytes',
      });
    }
    return getAddressDecoder().decode(publicKey);
  }

  async lookup(chainId: ChainId, publicKey: Uint8Array): Promise<VerifierRegistryEntry | null> {
    const verifier = this.addressOf(chainId, publicKey);
    const pda = await this.verifierPda(verifier);

    const account = await this.rpc
      .getAccountInfo(pda, { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!account.value) {
      return null;
    }

    const data = new Uint8Array(getBase64Encoder().encode(account.value.data[0]));
    return this.decode(data, verifier, pda);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Refuse a chain this service does not serve.
   *
   * `ChainVerifierRegistry` dispatches by namespace and would never route an
   * `eip155` lookup here — which is exactly why this exists: the multiplexer is
   * a *table*, and a table can be wired wrong. A registry that answered for a
   * chain it knows nothing about would report an EVM key as enrolled on the
   * strength of a Solana PDA, and it would look like a successful read.
   *
   * The check is on the NAMESPACE, not on a chain id: this service is bound to
   * one RPC endpoint and one program id, and which Solana cluster those are is
   * a deployment fact it has no way to verify from here.
   */
  private assertSolana(chainId: ChainId): void {
    if (namespaceOf(chainId) !== ChainNamespace.SOLANA) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
  }

  private async verifierPda(verifier: string): Promise<Address> {
    if (!this.programId) {
      throw ChainErrors.programNotConfigured({
        what: 'the settlement program',
        variable: SETTLEMENT_PROGRAM_ID_ENV,
      });
    }
    // Seeds from the program's own `#[account(seeds = ["verifier", verifier])]`,
    // by way of the IDL. Nothing here retypes them.
    const [pda] = await findVerifierKeyPda(
      { verifier: address(verifier) },
      { programAddress: address(this.programId) },
    );
    return pda;
  }

  private decode(data: Uint8Array, verifier: string, pda: Address): VerifierRegistryEntry {
    if (!discriminatorMatches(data)) {
      throw ChainErrors.accountLayoutUnexpected({
        account: pda,
        expected: 'a VerifierKey account',
        actual: Buffer.from(data.subarray(0, VERIFIER_KEY_DISCRIMINATOR.length)).toString('hex'),
      });
    }

    let decoded: ReturnType<ReturnType<typeof getVerifierKeyDecoder>['decode']>;
    try {
      decoded = getVerifierKeyDecoder().decode(data);
    } catch (cause) {
      // A short buffer, or a status byte outside the two variants the program
      // declares. Both mean the account is not what this code thinks it is, and
      // both must be loud — see the class comment. The codec's own message says
      // which, and it is kept as the reason rather than replaced.
      throw ChainErrors.accountLayoutUnexpected({
        account: pda,
        expected: `a ${VERIFIER_KEY_LENGTH}-byte VerifierKey with status Active or Revoked`,
        actual: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (decoded.verifier !== verifier) {
      throw ChainErrors.accountLayoutUnexpected({
        account: pda,
        expected: verifier,
        actual: decoded.verifier,
      });
    }

    return {
      address: verifier,
      status:
        decoded.status === VerifierStatus.Active
          ? RegisteredVerifierStatus.ACTIVE
          : RegisteredVerifierStatus.REVOKED,
      label: decodeLabel(decoded.label),
      registeredAt: toDate(decoded.registeredAt),
      expiresAt: toDate(decoded.expiresAt),
      // `0` is the program's "never revoked", not 1970.
      revokedAt: decoded.revokedAt === 0n ? null : toDate(decoded.revokedAt),
    };
  }
}

/**
 * 8 discriminator + 32 verifier + 1 status + 32 label + 8 + 8 + 8
 * (`registeredAt`, `expiresAt`, `revokedAt`) + 8 + 8 (the per-key rolling
 * slash cap: `slashedInWindow`, `slashWindowStartedAt`) + 1 bump.
 *
 * Lean v3 dropped `active_from`, so the account shrank by eight bytes and
 * every field after `registeredAt` moved back. Nothing here decodes against
 * either fact: the decoder is generated and this number is quoted only in the
 * error message above, so a reader who sees "expected a 114-byte VerifierKey"
 * knows what was expected.
 */
const VERIFIER_KEY_LENGTH = 114;

function discriminatorMatches(data: Uint8Array): boolean {
  const expected = VERIFIER_KEY_DISCRIMINATOR;
  if (data.length < expected.length) {
    return false;
  }
  return expected.every((byte, index) => data[index] === byte);
}

function toDate(seconds: bigint): Date {
  return new Date(Number(seconds) * 1000);
}

/** `[u8; 32]`, NUL-padded by the operator tooling that wrote it. */
function decodeLabel(bytes: ReadonlyUint8Array): string {
  const view = Uint8Array.from(bytes);
  const end = view.indexOf(0);
  return Buffer.from(end === -1 ? view : view.subarray(0, end)).toString('utf8');
}
