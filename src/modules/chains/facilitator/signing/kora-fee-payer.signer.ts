import { Inject, Injectable, Logger } from '@nestjs/common';
import { address, Address } from '@solana/kit';

import { AppError } from '@shared/errors/app-errors';
import {
  EgressHttpClient,
  EgressPolicy,
  INTERNAL_EGRESS_POLICY,
  isEgressError,
  withLimits,
} from '@shared/network/egress';
import { FacilitatorErrors } from '../errors/facilitator.errors';
import { FeePayerSignerPort, FeePayerSignResult } from './fee-payer-signer.port';
import { KORA_RPC_URL, KORA_TIMEOUT_MS } from './signer.constants';

/**
 * The production fee-payer signer — talks to our self-hosted Kora node over
 * its JSON-RPC 2.0 surface. Kora is the Solana Foundation's MIT-licensed
 * fee-payer relayer; this class is the entire integration, deliberately thin, because
 * the hard part (custody, policy enforcement, transaction submission) is
 * Kora's job, not ours.
 *
 * Method names and shapes come from reading the installed `kora-rpc` 1.0.3
 * binary's source (`kora-rpc/src/rpc.rs`, `kora-rpc/src/method/*.rs`) — Kora
 * ships no published OpenAPI/TypeScript client, and `kora-openapi` panics
 * without a running config. `result`
 * fields are snake_case on the wire (`fee_payer`, `signed_transaction`); this
 * class is where that gets translated to the camelCase `FeePayerSignerPort`.
 *
 * `KORA_RPC_URL` is operator configuration and defaults to `http://127.0.0.1:8080`
 * — Kora runs beside us, not on the public internet — so this is one of the two
 * call sites entitled to `EgressTrust.INTERNAL_ALLOWED`. That relaxes the
 * address check and nothing else; the scheme check, the pinned connect, the
 * redirect re-checking and the size and time caps all still apply.
 */
@Injectable()
export class KoraFeePayerSigner implements FeePayerSignerPort {
  readonly name = 'kora';

  private readonly logger = new Logger(KoraFeePayerSigner.name);
  private readonly policy: EgressPolicy;
  private feePayerCache?: Address;

  constructor(
    @Inject(KORA_RPC_URL) private readonly baseUrl: string,
    @Inject(KORA_TIMEOUT_MS) timeoutMs: number,
    private readonly egress: EgressHttpClient,
  ) {
    this.policy = withLimits(INTERNAL_EGRESS_POLICY, {
      headersTimeoutMs: timeoutMs,
      bodyTimeoutMs: timeoutMs,
      totalTimeoutMs: timeoutMs,
    });
  }

  async getFeePayerAddress(): Promise<Address> {
    // Kora holds the key; asking it every time would make every `/supported`
    // and every rule-1 check a network round trip for a value that only
    // changes on key rotation (every 90 days).
    if (this.feePayerCache) {
      return this.feePayerCache;
    }
    const { fee_payer: feePayer } = await this.call<{ fee_payer: string }>('getConfig', {});
    this.feePayerCache = address(feePayer);
    return this.feePayerCache;
  }

  async signAndSend(rawTransactionBase64: string): Promise<FeePayerSignResult> {
    const result = await this.call<{ signature: string; signed_transaction: string }>(
      'signAndSendTransaction',
      { transaction: rawTransactionBase64 },
    );
    return { signature: result.signature, signedTransaction: result.signed_transaction };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async call<T>(method: string, params: unknown): Promise<T> {
    try {
      const response = await this.egress.request({
        url: this.baseUrl,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        policy: this.policy,
      });

      const data = JSON.parse(response.body) as { error?: { message: string }; result?: T };

      if (data?.error) {
        throw FacilitatorErrors.signerUnavailable({
          signer: this.name,
          reason: `${method}: ${data.error.message}`,
        });
      }

      return data.result as T;
    } catch (error) {
      // `EgressError` is an `AppError` too, so the rethrow below would let a
      // refused or timed-out call escape as `EGRESS_*` and skip the port's
      // contract. Callers of `FeePayerSignerPort` branch on
      // `FACILITATOR_SIGNER_UNAVAILABLE`; a transport failure is exactly that,
      // and the egress code survives in the reason.
      if (error instanceof AppError && !isEgressError(error)) {
        throw error;
      }
      this.logger.error(`Kora ${method} failed: ${messageOf(error)}`);
      throw FacilitatorErrors.signerUnavailable({ signer: this.name, reason: messageOf(error) });
    }
  }
}

function messageOf(error: unknown): string {
  if (isEgressError(error)) {
    return `${error.code} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
