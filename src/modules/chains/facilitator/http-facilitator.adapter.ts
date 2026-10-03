import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  EgressHttpClient,
  EgressPolicy,
  INTERNAL_EGRESS_POLICY,
  isEgressError,
  withLimits,
} from '@shared/network/egress';
import { ChainErrors } from '../errors/chains.errors';
import { AccountId, ChainId, toAccountId } from '../ports/caip.types';
import { FacilitatorPort } from '../ports/facilitator.port';
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  TxRef,
  VerifyResponse,
} from '../ports/x402.types';
import { FACILITATOR_BASE_URL, FACILITATOR_TIMEOUT_MS } from './facilitator.constants';
import {
  FACILITATOR_ROUTES,
  FacilitatorRequestBody,
  SettleResponseBody,
  SupportedResponseBody,
  VerifyResponseBody,
  X402_INVALID_REASON,
  X402_VERSION,
} from './facilitator.wire';

/**
 * `FacilitatorPort` over HTTP — the **client** half of the self-hosted
 * facilitator.
 *
 * The payments domain never calls a facilitator directly; it calls this. On
 * Solana the URL points at our own Kora wrapper (the server half, same
 * repository, its own process and its own key); it could equally point at a
 * third-party facilitator. Swapping one for the other is a URL, not a code change —
 * which is the entire reason both sit behind one port.
 *
 * ## Why nothing here is retried
 *
 * A `/settle` whose response was lost has, from our side, an unknown outcome —
 * the transaction may well have landed. Retrying it asks the facilitator to
 * broadcast a second time. The facilitator's 120-second dedup cache is what
 * makes that survivable, but relying on a remote cache to undo a retry we chose
 * to make is backwards. We ask once, and an ambiguous settlement is resolved by
 * the reconciler against the chain, which is the only party that
 * actually knows. `EgressHttpClient` has no retry loop at all, which is the
 * behaviour this path wants; `/verify` and `/supported` inherit it.
 *
 * ## Why the egress policy is `INTERNAL_ALLOWED`
 *
 * `FACILITATOR_BASE_URL` comes from the environment, and on Solana it points at
 * our own Kora wrapper — `127.0.0.1` in development, a private address in
 * production. `PUBLIC_ONLY` would refuse to dial it. Everything else the egress
 * guard does still applies: scheme check, a connection pinned to the resolved
 * address, per-hop redirect re-checking, and the size and time caps. See
 * `EgressTrust.INTERNAL_ALLOWED` for why this must never be given to a URL that
 * arrived from outside the process.
 */
@Injectable()
export class HttpFacilitatorAdapter implements FacilitatorPort {
  readonly name = 'http';

  private readonly logger = new Logger(HttpFacilitatorAdapter.name);
  private readonly baseUrl: string;
  private readonly policy: EgressPolicy;

  constructor(
    @Inject(FACILITATOR_BASE_URL) baseUrl: string,
    @Inject(FACILITATOR_TIMEOUT_MS) timeoutMs: number,
    private readonly egress: EgressHttpClient,
  ) {
    this.baseUrl = baseUrl;
    this.policy = withLimits(INTERNAL_EGRESS_POLICY, {
      headersTimeoutMs: timeoutMs,
      bodyTimeoutMs: timeoutMs,
      totalTimeoutMs: timeoutMs,
    });
  }

  async supports(chainId: ChainId, scheme: string): Promise<boolean> {
    const kinds = await this.supported();
    return kinds.some(
      (kind) =>
        kind.network === chainId && kind.scheme === scheme && kind.x402Version === X402_VERSION,
    );
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const body = await this.post<VerifyResponseBody>(
      FACILITATOR_ROUTES.VERIFY,
      payload,
      requirements,
    );

    if (!body) {
      // The facilitator is unreachable or answered something that is not a
      // verify response. Neither is "the payment is fine".
      return { isValid: false, invalidReason: X402_INVALID_REASON.UNEXPECTED_SETTLE_ERROR };
    }

    return {
      isValid: body.isValid === true,
      ...(body.invalidReason ? { invalidReason: body.invalidReason } : {}),
      ...(body.payer ? { payer: this.asAccountId(requirements.network, body.payer) } : {}),
    };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const body = await this.post<SettleResponseBody>(
      FACILITATOR_ROUTES.SETTLE,
      payload,
      requirements,
    );

    if (!body) {
      return {
        success: false,
        errorReason: X402_INVALID_REASON.UNEXPECTED_SETTLE_ERROR,
        network: requirements.network,
      };
    }

    return {
      success: body.success === true,
      network: body.network ?? requirements.network,
      ...(body.errorReason ? { errorReason: body.errorReason } : {}),
      ...(body.transaction ? { transaction: body.transaction as TxRef } : {}),
      ...(body.payer ? { payer: this.asAccountId(requirements.network, body.payer) } : {}),
    };
  }

  async getFeePayer(chainId: ChainId): Promise<AccountId> {
    const kind = (await this.supported()).find((entry) => entry.network === chainId);
    const feePayer = kind?.extra?.feePayer;

    if (typeof feePayer !== 'string') {
      throw ChainErrors.facilitatorUnavailable({
        chainId,
        reason: 'facilitator advertises no fee payer for this network',
      });
    }

    return this.asAccountId(chainId, feePayer);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async supported(): Promise<SupportedResponseBody['kinds']> {
    try {
      const response = await this.egress.request({
        url: this.routeUrl(FACILITATOR_ROUTES.SUPPORTED),
        method: 'GET',
        policy: this.policy,
      });
      const data = parseJson<SupportedResponseBody>(response.body);
      return Array.isArray(data?.kinds) ? data.kinds : [];
    } catch (error) {
      this.logger.warn(`GET ${FACILITATOR_ROUTES.SUPPORTED} failed: ${messageOf(error)}`);
      return [];
    }
  }

  /**
   * Returns the parsed body, or `null` when there is no body to trust.
   *
   * A transport failure and a facilitator that answered with an error document
   * are the same thing to the caller: we do not know that this payment is good.
   * The distinction is preserved in the log, not in the return type, because no
   * caller should branch on it.
   */
  private async post<T>(
    route: string,
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<T | null> {
    const body: FacilitatorRequestBody = {
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
    };

    try {
      // A `402` or a `400` from the facilitator is information, not a transport
      // failure — `EgressHttpClient` never throws on a status, so the body is
      // read either way and only a `5xx` is treated as "no answer".
      const response = await this.egress.request({
        url: this.routeUrl(route),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        policy: this.policy,
      });

      const data = parseJson<T>(response.body);

      if (response.status >= 500 || data === null) {
        this.logger.warn(`POST ${route} answered ${response.status}`);
        return null;
      }

      return data;
    } catch (error) {
      this.logger.warn(`POST ${route} failed: ${messageOf(error)}`);
      return null;
    }
  }

  /** `new URL` rather than string concatenation, so a base with a path keeps it. */
  private routeUrl(route: string): string {
    return new URL(route.replace(/^\//, ''), ensureTrailingSlash(this.baseUrl)).href;
  }

  private asAccountId(chainId: ChainId, address: string): AccountId {
    return toAccountId(chainId, address);
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function parseJson<T>(body: string): T | null {
  if (body.trim().length === 0) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  if (isEgressError(error)) {
    return `${error.code} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
