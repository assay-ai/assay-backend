import { ChainId, namespaceOf } from '../ports/caip.types';
import { FacilitatorPort } from '../ports/facilitator.port';
import { PaymentPayload, PaymentRequirements } from '../ports/x402.types';
import { implementationFor } from './namespace-dispatch';

/**
 * `FacilitatorPort` over more than one namespace.
 *
 * `verify` and `settle` dispatch on **`requirements.network`** — what the
 * platform advertised — never on `payload.network`, which the client wrote. A
 * payload claiming another namespace then reaches the member for the chain the
 * intent is actually on, and that member refuses it as `invalid_network`; it is
 * never handed to a facilitator the platform did not choose.
 *
 * The token resolved to `HttpFacilitatorAdapter` alone until this existed, and
 * that service advertises only Solana networks — so every eip155 deposit that
 * passed its binding check died at `/verify` with `invalid_network`.
 */
export class NamespaceFacilitator implements FacilitatorPort {
  readonly name = 'namespace';

  constructor(private readonly byNamespace: ReadonlyMap<string, FacilitatorPort>) {}

  /** `false` for a namespace nobody serves — a question, not a demand. */
  async supports(chainId: ChainId, scheme: string): Promise<boolean> {
    const member = this.byNamespace.get(namespaceOf(chainId));
    return member ? member.supports(chainId, scheme) : false;
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    return implementationFor(this.byNamespace, requirements.network).verify(payload, requirements);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements) {
    return implementationFor(this.byNamespace, requirements.network).settle(payload, requirements);
  }

  async getFeePayer(chainId: ChainId) {
    return implementationFor(this.byNamespace, chainId).getFeePayer(chainId);
  }
}
