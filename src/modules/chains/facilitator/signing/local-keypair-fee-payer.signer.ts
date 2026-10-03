import { readFile } from 'node:fs/promises';

/** A bare ed25519 seed, as opposed to `solana-keygen`'s seed ++ public half. */
const SEED_ONLY_BYTES = 32;

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Address,
  createKeyPairFromBytes,
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from '@solana/kit';

import { FACILITATOR_SOLANA_RPC } from '../facilitator.tokens';
import { FacilitatorErrors } from '../errors/facilitator.errors';
import { FeePayerSignerPort, FeePayerSignResult } from './fee-payer-signer.port';
import { LOCAL_FEE_PAYER_KEYPAIR_PATH } from './signer.constants';

/**
 * The slice of the Solana JSON-RPC this signer submits through — declared
 * structurally so a test supplies a fake `sendTransaction` instead of a live
 * RPC connection, same reasoning as `SolanaChainAdapter`'s `SolanaRpcClient`
 * and `decode-svm-payload.ts`'s `FacilitatorSvmRpcClient`.
 */
export interface LocalSignerRpcClient {
  sendTransaction(
    base64Transaction: string,
    config: { readonly encoding: 'base64' },
  ): { send(): Promise<string> };
}

/**
 * The fallback fee-payer signer — signs with a keypair loaded directly into
 * this process and submits over the Solana RPC. It exists for exactly two
 * reasons: the
 * facilitator must be runnable when Kora is not up, and tests must be
 * hermetic. **It is deliberately not the production path.**
 *
 * The production fee payer belongs in a KMS (Kora-native) specifically so the
 * key never sits in a process's memory. This class does the opposite on
 * purpose, which is why it refuses to start under `NODE_ENV=production` and
 * logs loudly every time it does start.
 */
@Injectable()
export class LocalKeypairFeePayerSigner implements FeePayerSignerPort {
  readonly name = 'local';

  private readonly logger = new Logger(LocalKeypairFeePayerSigner.name);
  private readonly keyPairPromise: Promise<CryptoKeyPair>;
  private addressCache?: Address;

  constructor(
    @Inject(LOCAL_FEE_PAYER_KEYPAIR_PATH) keypairSource: string | Uint8Array,
    @Inject(FACILITATOR_SOLANA_RPC) private readonly rpc: LocalSignerRpcClient,
  ) {
    if (process.env.NODE_ENV === 'production') {
      throw FacilitatorErrors.localSignerForbiddenInProduction();
    }

    this.logger.warn('================================================================');
    this.logger.warn('FEE_PAYER_SIGNER=local — the fee-payer private key is loaded into');
    this.logger.warn('THIS process. This is NOT the production path. Kora (behind AWS');
    this.logger.warn('KMS) is. Set FEE_PAYER_SIGNER=kora before deploying anywhere real.');
    this.logger.warn('================================================================');

    this.keyPairPromise = this.loadKeyPair(keypairSource);
  }

  async getFeePayerAddress(): Promise<Address> {
    if (this.addressCache) {
      return this.addressCache;
    }
    const keyPair = await this.keyPairPromise;
    this.addressCache = await getAddressFromPublicKey(keyPair.publicKey);
    return this.addressCache;
  }

  async signAndSend(rawTransactionBase64: string): Promise<FeePayerSignResult> {
    const keyPair = await this.keyPairPromise;
    const unsigned = getTransactionDecoder().decode(
      getBase64Encoder().encode(rawTransactionBase64),
    );
    const signed = await partiallySignTransaction([keyPair], unsigned);
    const signedTransaction = getBase64Decoder().decode(getTransactionEncoder().encode(signed));

    const signature = await this.rpc
      .sendTransaction(signedTransaction, { encoding: 'base64' })
      .send();
    return { signature, signedTransaction };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Accepts the material either **inline** or as a **path** to it.
   *
   * Inline is what a deployment config can supply; a path is what a developer's `.env`
   * already points at. Both end at the same `CryptoKeyPair`, and the caller —
   * `FacilitatorModule` — decides which arrived. Deciding here, by sniffing the
   * shape of a string, would make an unreadable file and a malformed key the
   * same error.
   */
  private async loadKeyPair(source: string | Uint8Array): Promise<CryptoKeyPair> {
    const bytes = source instanceof Uint8Array ? source : await this.readKeypairFile(source);

    // `solana-keygen` writes 64 bytes (seed ++ public half); a bare 32-byte
    // seed is the other shape operators paste, and kit has a separate factory
    // for it. Length is the only thing that distinguishes them.
    return bytes.length === SEED_ONLY_BYTES
      ? createKeyPairFromPrivateKeyBytes(bytes)
      : createKeyPairFromBytes(bytes);
  }

  private async readKeypairFile(path: string): Promise<Uint8Array> {
    // The same 64-byte `solana-keygen`-format JSON array as the CLI keypair
    // files this module is asked to run against — no bespoke format to document or get wrong.
    const raw = await readFile(path, 'utf8');
    return new Uint8Array(JSON.parse(raw));
  }
}
