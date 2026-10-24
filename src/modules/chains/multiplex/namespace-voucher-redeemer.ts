import {
  RedeemOutcome,
  RedeemVoucherRequest,
  UsedSeqRecord,
  VoucherRedeemerPort,
} from '@modules/payment/ports/voucher-redeemer.port';

import { ChainErrors } from '../errors/chains.errors';
import { AccountId, AssetId, ChainId, chainIdOf, namespaceOf } from '../ports/caip.types';
import { implementationFor } from './namespace-dispatch';

/**
 * `VoucherRedeemerPort` over more than one namespace.
 *
 * Dispatch is on `request.payer` — the escrow being debited is the payer's, and
 * a redemption is a transaction on the payer's chain whatever the provider's
 * payout account happens to be.
 *
 * ## `maxBatchSize` is the MINIMUM across implementations, and that has a cost
 *
 * `VoucherRedemptionService` reads this number and forms a batch **before** it
 * knows which chain the rows are on, so the batch has to be safe on the least
 * capable implementation. Solana's answer is `1` (measured: one
 * `redeem_voucher` plus its ed25519 precompile is 1,187 of a legacy
 * transaction's 1,232 bytes), so on a deployment serving both chains this is `1`
 * and the service takes its per-row path.
 *
 * **The consequence is that EVM batching is inert while Solana is
 * enabled.** Single redemptions still route to the EVM implementation and still
 * work; what is off is putting 64 of them in one transaction. Making it live
 * needs `VoucherRedemptionService` to group its pending rows by chain and ask
 * per chain — which is a redemption pass per chain, not a bigger batch — and
 * that is not done yet rather than approximated here. Reporting
 * `64` instead would hand Solana a batch it cannot send.
 *
 * ## A batch spanning two namespaces is refused by name
 *
 * A batch is one transaction and a transaction is on one chain. Splitting one
 * here would silently return outcomes from two transactions under one call, and
 * `VoucherRedemptionService` matches a hold to an outcome **by index and by
 * nothing else** — so a split that reordered anything would retire the wrong
 * hold and pay the wrong provider. Unreachable through the service today
 * (`maxBatchSize` is 1); present because the port is public and the rule is a
 * property of the chain rather than of the current wiring.
 */
export class NamespaceVoucherRedeemer implements VoucherRedeemerPort {
  readonly maxBatchSize: number;

  constructor(private readonly byNamespace: ReadonlyMap<string, VoucherRedeemerPort>) {
    const sizes = [...byNamespace.values()].map((redeemer) => redeemer.maxBatchSize);
    // `1` for an empty map rather than `Infinity`: a deployment with no redeemer
    // wired must not advertise an unbounded batch on its way to failing.
    this.maxBatchSize = sizes.length > 0 ? Math.min(...sizes) : 1;
  }

  /** The chain's own answer; `true` (the safe one) when its redeemer gives none. */
  requiresAscendingSeq(id: ChainId | AccountId | AssetId): boolean {
    return implementationFor(this.byNamespace, id).requiresAscendingSeq?.(id) ?? true;
  }

  async redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome> {
    return implementationFor(this.byNamespace, request.payer).redeem(request);
  }

  /**
   * The payer's chain's answer, or `null` (no landing found) on a chain whose
   * redeemer cannot look — which closes that chain's refusal at once, as before.
   */
  async findLanding(
    request: RedeemVoucherRequest,
    txRefs: readonly string[],
  ): Promise<string | null> {
    const redeemer = implementationFor(this.byNamespace, request.payer);
    return redeemer.findLanding ? redeemer.findLanding(request, txRefs) : null;
  }

  /**
   * The payer's chain's live answer, `false` on a chain whose redeemer cannot
   * read it — the same "not asked" the service gives a missing door.
   */
  async providerBelowMinimumStake(request: RedeemVoucherRequest): Promise<boolean> {
    const redeemer = implementationFor(this.byNamespace, request.payer);
    return redeemer.providerBelowMinimumStake ? redeemer.providerBelowMinimumStake(request) : false;
  }

  /** The payer's chain's answer; `false` on a chain that cannot tell (review 2026-10-24 wave 2 M-2). */
  async providerShortOnlyByUnplannedSlashes(request: RedeemVoucherRequest): Promise<boolean> {
    const redeemer = implementationFor(this.byNamespace, request.payer);
    return redeemer.providerShortOnlyByUnplannedSlashes
      ? redeemer.providerShortOnlyByUnplannedSlashes(request)
      : false;
  }

  /**
   * The payer's chain's record of the seq. Only `eip155` refuses
   * `VoucherSeqUsed`, the one refusal this is asked after; a chain without
   * per-seq records throws, which keeps the hold open.
   */
  async usedSeqRecord(request: RedeemVoucherRequest): Promise<UsedSeqRecord> {
    const redeemer = implementationFor(this.byNamespace, request.payer);
    if (!redeemer.usedSeqRecord) {
      throw ChainErrors.unsupportedChain({ chainId: chainIdOf(request.payer) });
    }
    return redeemer.usedSeqRecord(request);
  }

  async redeemBatch(requests: readonly RedeemVoucherRequest[]): Promise<readonly RedeemOutcome[]> {
    if (requests.length === 0) return [];

    const namespaces = new Set(requests.map((request) => namespaceOf(request.payer)));
    if (namespaces.size > 1) {
      throw ChainErrors.namespaceMismatch({
        expected: namespaceOf(requests[0].payer),
        actual: [...namespaces].join(', '),
      });
    }

    const redeemer = this.byNamespace.get([...namespaces][0]);
    if (!redeemer) {
      throw ChainErrors.unsupportedChain({ chainId: chainIdOf(requests[0].payer) });
    }

    return redeemer.redeemBatch(requests);
  }
}
