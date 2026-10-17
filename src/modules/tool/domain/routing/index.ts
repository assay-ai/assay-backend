/**
 * The router's decision logic.
 *
 * ```text
 * candidates ──filterEligible──▶ eligible ──scoreCandidates──▶ scored
 *                  │                                             │
 *          not already tried                              computeWeights
 *          a chain BOTH parties can settle on                     │
 *            (settleableChains, then                        pickWeighted
 *             chooseSettlementChain)                              │
 *          binding ACTIVE                                        │
 *          provider ACTIVE                                       │
 *          payout address proved ON THAT CHAIN                   │
 *          stake >= minimumStake ON THAT CHAIN                   │
 *          under its declared ceiling                            ▼
 *                                                          one ToolBinding
 * ```
 *
 * The chain gate is **second**, right after the failover exclusion and ahead of
 * every provider-shaped rejection. Both are properties of the request rather
 * than of the provider, and reporting `BINDING_NOT_ACTIVE` to a buyer who could
 * never have paid this provider puts a rejection in that provider's console
 * they are expected to fix and cannot.
 *
 * Pure, like `domain/mapping/` and `domain/classification/` next door. Nothing
 * here opens a socket, reads a clock or touches a repository — the service in
 * `services/provider-router.service.ts` gathers the inputs, performs the call
 * and enforces the deadline, and everything that *decides* lives here.
 *
 * The separation earns its keep in two places. A distribution claim ("no
 * provider exceeds 60% of a tool's traffic") is testable by running the
 * decision a few thousand times with a seeded generator, which is not something
 * you can do to a function that dials providers. And a disputed call
 * has to be answerable with *why this binding* — which requires the
 * decision to be replayable from its recorded inputs.
 */

export * from './routing.types';
export * from './chain-gate';
export * from './withdraw-gate';
export * from './payout-gate';
export * from './stake-gate';
export * from './stake-grace';
export * from './eligibility';
export * from './score';
export * from './weights';
export * from './weighted-pick';
export * from './rules';
