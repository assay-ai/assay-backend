import { ChainId, isChainId } from '@modules/chains/ports/caip.types';
import { PaymentRequirements } from '@modules/chains/ports/x402.types';

import { PaymentErrors } from '../errors/payment.errors';

/**
 * The two narrowings `DepositsController` needs to build a typed value out of
 * an untyped one — and the reason both live here rather than in the controller.
 *
 * `test/unit/shared/api/surface-consistency.spec.ts` enforces *"no controller
 * throws — errors come from services, via a domain catalog"*: one error shape
 * on the whole surface, produced in one kind of place. A narrowing that
 * refuses is a domain rule about what a value must be, not request plumbing,
 * so it belongs beside `assertDepositAssetIsSettlementAsset` in this
 * directory.
 *
 * Neither of these casts. A cast here is not a shortcut, it is a decision to
 * ship a malformed value — see each function for what that costs.
 */

/**
 * Read one `PaymentRequirements.extra` field the client cannot build a
 * transfer without.
 *
 * `extra` is `Record<string, unknown>` because it is chain-specific by design,
 * so `feePayer` and `memo` arrive untyped. Cast instead of checked, a missing
 * `feePayer` becomes the string `"undefined"` in a `402` response, the browser
 * builds and signs a transaction against it, and the failure surfaces at the
 * facilitator as an invalid payload the buyer has no way to interpret.
 *
 * `502`, not `400`: the value comes from the facilitator, so nothing the
 * caller sent could have caused it or can fix it.
 */
export function readRequiredExtra(requirements: PaymentRequirements, field: string): string {
  const value = requirements.extra?.[field];
  if (typeof value !== 'string') {
    throw PaymentErrors.depositRequirementsIncomplete({ field: `extra.${field}` });
  }
  return value;
}

/**
 * Narrow a request-supplied network string to the branded `ChainId` that
 * `PaymentPayload` requires.
 *
 * Deliberately **not** "overwrite it with the session's chain". The network is
 * part of what the buyer signed over, and the adapter checks it against the
 * intent (`assertPayloadBoundToIntent`); substituting our own value would
 * silence exactly the mismatch that check exists to catch. Left as a bare cast
 * instead, a malformed network fails much later as a chain-SDK error inside a
 * decode rather than as a `400` at the edge.
 */
export function asPayloadChainId(network: string): ChainId {
  if (!isChainId(network)) {
    throw PaymentErrors.invalidPayload({ reason: `network is not a CAIP-2 chain id: ${network}` });
  }
  return network;
}

/**
 * The x402 scheme every deposit is quoted in — `SOLANA_PAYMENT_SCHEME` and
 * `EVM_PAYMENT_SCHEME` alike.
 */
export const DEPOSIT_PAYMENT_SCHEME = 'exact';

/**
 * Refuse a settle body in another scheme before its payload is decoded, so
 * the caller is told the scheme is wrong rather than that the bytes are.
 */
export function assertDepositScheme(scheme: string): void {
  if (scheme !== DEPOSIT_PAYMENT_SCHEME) {
    throw PaymentErrors.unsupportedScheme({
      reason: `deposits are settled in the ${DEPOSIT_PAYMENT_SCHEME} scheme, not ${scheme}`,
    });
  }
}
