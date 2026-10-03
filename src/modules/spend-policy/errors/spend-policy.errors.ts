import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `SPEND_POLICY_*` — the append-only limits table.
 *
 * A new domain module, not one of the seven named in `docs/architecture.md`
 * §"Module Structure Pattern" — that list predates the dashboard API surface,
 * which added five tables the MVP shipped without (see the migration header,
 * `1756000000000-create-api-surface-tables`). `spend-policy` is one of them.
 */
export enum SpendPolicyErrorCode {
  SPEND_POLICY_NOT_FOUND = 'SPEND_POLICY_NOT_FOUND',
  SPEND_POLICY_ASSET_REQUIRED = 'SPEND_POLICY_ASSET_REQUIRED',
  SPEND_POLICY_CONCURRENT_MODIFICATION = 'SPEND_POLICY_CONCURRENT_MODIFICATION',
}

export type SpendPolicyErrorCodesArePrefixed = AssertDomainErrorCodes<
  'SPEND_POLICY',
  `${SpendPolicyErrorCode}`
>;

export const SpendPolicyErrors = createDomainErrorFactory('SPEND_POLICY', {
  /** No live policy at the agent's scope, and no organization default either. */
  notFound: {
    code: SpendPolicyErrorCode.SPEND_POLICY_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No spend policy configured${context?.agentId ? ` for agent ${context.agentId}` : ''}` +
      ` and no organization default exists yet`,
  },
  /**
   * The very first version at a scope must name its asset — there is nothing
   * to inherit it from. Every version after that keeps the asset of the one it
   * supersedes unless the caller changes it explicitly.
   */
  assetRequired: {
    code: SpendPolicyErrorCode.SPEND_POLICY_ASSET_REQUIRED,
    statusCode: 400,
    message: () =>
      `assetId and decimals are required: this is the first policy version at this scope, ` +
      `and there is no organization default to inherit them from`,
  },
  /**
   * Lost the compare-and-set on the row being superseded — a concurrent PATCH
   * won. Same shape as `LEDGER_HOLD_ALREADY_RESOLVED`: the caller should
   * re-read the live policy and decide whether to retry, not assume its write
   * landed.
   */
  concurrentModification: {
    code: SpendPolicyErrorCode.SPEND_POLICY_CONCURRENT_MODIFICATION,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The policy being superseded was already changed by another request` +
      `${context?.id ? ` (${context.id})` : ''}. Re-read the live policy and retry`,
  },
});
