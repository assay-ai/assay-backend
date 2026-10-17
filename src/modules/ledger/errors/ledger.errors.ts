import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `LEDGER_*` — the append-only journal, balances, holds and `withheld`.
 */
export enum LedgerErrorCode {
  LEDGER_ACCOUNT_NOT_FOUND = 'LEDGER_ACCOUNT_NOT_FOUND',
  LEDGER_ENTRY_NOT_FOUND = 'LEDGER_ENTRY_NOT_FOUND',
  LEDGER_ENTRY_IMMUTABLE = 'LEDGER_ENTRY_IMMUTABLE',
  LEDGER_INSUFFICIENT_AVAILABLE_BALANCE = 'LEDGER_INSUFFICIENT_AVAILABLE_BALANCE',
  LEDGER_HOLD_NOT_FOUND = 'LEDGER_HOLD_NOT_FOUND',
  LEDGER_HOLD_ALREADY_RESOLVED = 'LEDGER_HOLD_ALREADY_RESOLVED',
  LEDGER_ASSET_MISMATCH = 'LEDGER_ASSET_MISMATCH',
  LEDGER_RECONCILIATION_MISMATCH = 'LEDGER_RECONCILIATION_MISMATCH',
  LEDGER_NEGATIVE_BALANCE = 'LEDGER_NEGATIVE_BALANCE',
  LEDGER_INVALID_ACCOUNT_ID = 'LEDGER_INVALID_ACCOUNT_ID',
  LEDGER_HOLD_ALREADY_OPEN = 'LEDGER_HOLD_ALREADY_OPEN',
  LEDGER_SNAPSHOT_DRIFT = 'LEDGER_SNAPSHOT_DRIFT',
  LEDGER_UNKNOWN_ENTRY_TYPE = 'LEDGER_UNKNOWN_ENTRY_TYPE',
  LEDGER_SETTLEMENT_CREDIT_MISMATCH = 'LEDGER_SETTLEMENT_CREDIT_MISMATCH',
  LEDGER_SETTLEMENT_CREDIT_MISSING_CHAIN_REF = 'LEDGER_SETTLEMENT_CREDIT_MISSING_CHAIN_REF',
}

export type LedgerErrorCodesArePrefixed = AssertDomainErrorCodes<'LEDGER', `${LedgerErrorCode}`>;

export const LedgerErrors = createDomainErrorFactory('LEDGER', {
  accountNotFound: {
    code: LedgerErrorCode.LEDGER_ACCOUNT_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Ledger account not found${context?.accountId ? `: ${context.accountId}` : ''}`,
  },
  entryNotFound: {
    code: LedgerErrorCode.LEDGER_ENTRY_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Ledger entry not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
  entryImmutable: {
    code: LedgerErrorCode.LEDGER_ENTRY_IMMUTABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Ledger entries are append-only and cannot be modified` +
      `${context?.id ? ` (attempted on ${context.id})` : ''}`,
  },
  insufficientAvailableBalance: {
    code: LedgerErrorCode.LEDGER_INSUFFICIENT_AVAILABLE_BALANCE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Insufficient available balance` +
      `${context?.accountId ? ` on ${context.accountId}` : ''}` +
      `${context?.required ? `: required ${context.required}, available ${context.available ?? '0'}` : ''}`,
  },
  holdNotFound: {
    code: LedgerErrorCode.LEDGER_HOLD_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Hold not found${context?.intentId ? ` for intent: ${context.intentId}` : ''}`,
  },
  holdAlreadyResolved: {
    code: LedgerErrorCode.LEDGER_HOLD_ALREADY_RESOLVED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Hold already ${context?.resolution ?? 'resolved'}` +
      `${context?.requested ? `, cannot be ${context.requested}` : ''}` +
      `${context?.intentId ? ` (intent: ${context.intentId})` : ''}` +
      `${context?.holdId ? ` [hold ${context.holdId}]` : ''}`,
  },
  holdAlreadyOpen: {
    code: LedgerErrorCode.LEDGER_HOLD_ALREADY_OPEN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `An open hold already exists` +
      `${context?.intentId ? ` for intent: ${context.intentId}` : ''}`,
  },
  assetMismatch: {
    code: LedgerErrorCode.LEDGER_ASSET_MISMATCH,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Asset mismatch${context?.expected ? `: expected ${context.expected}, got ${context.actual}` : ''}`,
  },
  reconciliationMismatch: {
    code: LedgerErrorCode.LEDGER_RECONCILIATION_MISMATCH,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Ledger does not reconcile with on-chain state` +
      `${context?.delta ? `: delta ${context.delta}` : ''}`,
  },
  /**
   * The journal folds to an impossible state. Raised instead of clamping to
   * zero: a clamped balance is a plausible-looking number that hides the bug
   * that produced it, and this is the one place in the system where a loud
   * failure is cheaper than a quiet approximation.
   */
  negativeBalance: {
    code: LedgerErrorCode.LEDGER_NEGATIVE_BALANCE,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Balance folded negative${context?.accountId ? ` on ${context.accountId}` : ''}` +
      `${context?.buckets ? ` (${context.buckets})` : ''}` +
      `: available=${context?.available ?? '?'}, held=${context?.held ?? '?'}, pending=${context?.pending ?? '?'}`,
  },
  invalidAccountId: {
    code: LedgerErrorCode.LEDGER_INVALID_ACCOUNT_ID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Not a ledger account id (expected CAIP-10 or a platform account): ${context?.value}`,
  },
  /**
   * A stored `entry_type` this build has no balance effect for — a row written
   * by a different deployment. Unreachable from typed code; reachable from data.
   */
  unknownEntryType: {
    code: LedgerErrorCode.LEDGER_UNKNOWN_ENTRY_TYPE,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `No balance effect is declared for ledger entry type "${context?.entryType}"`,
  },
  snapshotDrift: {
    code: LedgerErrorCode.LEDGER_SNAPSHOT_DRIFT,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Balance snapshot disagrees with the journal` +
      `${context?.accountId ? ` on ${context.accountId}` : ''}` +
      `${context?.detail ? `: ${context.detail}` : ''}`,
  },
  /**
   * `providerAmount + platformFee !== the hold's own committed amount`.
   *
   * `payment_intents` carries a CHECK that the two sum to `price`, so this
   * should be unreachable through `PaymentIntentService` — it exists for the
   * caller that reaches `commitHoldAndCredit` some other way, so a
   * conservation bug fails loudly here rather than three books later, in
   * `foldLiabilities`, as a total that quietly stopped matching.
   */
  settlementCreditMismatch: {
    code: LedgerErrorCode.LEDGER_SETTLEMENT_CREDIT_MISMATCH,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Settlement credit does not conserve the committed hold` +
      `${context?.holdId ? ` [hold ${context.holdId}]` : ''}` +
      `${context?.committed ? `: committed ${context.committed}, providerAmount + platformFee = ${context.credited ?? '?'}` : ''}`,
  },
  /**
   * A `HOLD_COMMIT` was asked for without naming the transaction that moved
   * the money.
   *
   * The ledger is a mirror of the chain now. A commit is a statement that
   * `redeem_voucher` landed, and a statement with no signature behind it is
   * how the mirror quietly becomes the source of truth again — which is the
   * one property this whole change removes. `SettlementCredit.chainTxRef` is
   * required at compile time; this is the runtime half, for the caller that
   * reaches past the type.
   *
   * A 500 rather than a 400: no HTTP request carries this field, so a missing
   * ref is always a defect in a caller and never bad input from a client.
   */
  settlementCreditMissingChainRef: {
    code: LedgerErrorCode.LEDGER_SETTLEMENT_CREDIT_MISSING_CHAIN_REF,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Cannot commit a hold without naming the transaction that moved the money` +
      `${context?.holdId ? ` [hold ${context.holdId}]` : ''}`,
  },
});
