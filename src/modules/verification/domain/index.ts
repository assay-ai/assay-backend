/**
 * The verification engine's pure core.
 *
 * ```text
 * verify(input) ──┬── SCHEMA              ──┐
 *                 ├── DETERMINISTIC_RULES ──┤ first stage that does not pass
 *                 ├── CROSS_CHECK           │ decides; the rest are NOT_REACHED
 *                 └── SEMANTIC              │
 *                                           ▼
 *                                        Verdict ── VERDICT_CONSEQUENCE ──▶ settle | refund | void
 * ```
 *
 * Pure, like the mapping engine and the classifier it sits behind: policy in,
 * response in, `evaluatedAt` in, verdict out. Nothing here opens a socket,
 * reads a clock or touches a repository, so a call disputed months later
 * re-evaluates from its stored receipt to the same answer — which dispute
 * arbitration needs to be demonstrable rather than asserted.
 */

export * from './verdict';
export * from './stage';
export * from './sampling';
export * from './semantic.types';
export * from './semantic-context';
export * from './semantic-prompt';
export * from './policy.types';
export * from './rules/rule.types';
export * from './rules/condition';
export * from './rules/empty-result';
export * from './rules/evaluate-rules';
export * from './stages/schema-stage';
export * from './stages/deterministic-stage';
export * from './stages/semantic-stage';
export * from './engine';
export * from './lifecycle/kill-switch';
export * from './lifecycle/promotion';
export * from './aggregation';
