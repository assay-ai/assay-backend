/**
 * Multi-verifier aggregation and the policy lifecycle.
 *
 * ```text
 *  schema ─┐
 *  rules ──┤  VerifierResult[]      DecisionPolicy (versioned, promoted)
 *  cross ──┤────────────────────▶   clauses, first match wins   ──▶  AggregatedVerdict
 *  semantic┤                                  ▲                            │
 *  3rd-pty ┘                          kill switch (Redis)                  │
 *                                     withdraws → DEGRADED         settlementDecision()
 *                                                                          │
 *                                                                          ▼
 *                                                          settlement sees a status,
 *                                                          never a verifier
 * ```
 */

export * from './verifier.types';
export * from './decision-policy.types';
export * from './aggregate';
export * from './run-verifiers';
export * from './withdrawn';
export * from './settlement-decision';
export * from './default-policy';
