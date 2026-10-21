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
  SPEND_POLICY_DROP_REFUSED = 'SPEND_POLICY_DROP_REFUSED',
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
  /**
   * `DELETE /spend-policy/agents/:agentId` would change more than the agent's
   * limits (BUG-BUY-CONNECT-05): the agent's own row also carries its tool
   * access, agent rules and pinned tools (`ACCESS_DIFFERS`), or its pause
   * (`PAUSED`), and dropping the row would widen or resume the agent. Change
   * the limits, or the access, instead.
   */
  dropRefused: {
    code: SpendPolicyErrorCode.SPEND_POLICY_DROP_REFUSED,
    statusCode: 409,
    publicContext: ['reason'],
    message: (context?: Record<string, any>) =>
      context?.reason === 'PAUSED'
        ? `The agent is paused and the account default is not: using the account default ` +
          `would resume it. Resume the agent first`
        : `The agent has its own tool access or agent rules, kept in the same policy: using ` +
          `the account default would change them too. Change the agent's limits instead`,
  },
});
