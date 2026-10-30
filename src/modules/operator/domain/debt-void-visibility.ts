import { lookupOverride, OperatorRole } from './override-register';

/** The approval action of a bulk buyer-debt void (register code `M-1`). */
export const BUYER_DEBT_BULK_VOID_ACTION = 'buyer_debt.bulk_void';

/** The register code whose roles may read what a bulk void did. */
const DEBT_VOID_CODE = 'M-1';

/**
 * Whether an operator holding `roles` may read what a bulk buyer-debt void did:
 * the approval's `result` and the activity feed's `outcome` — intent ids,
 * counts and amounts (review 2026-10-30 M-5). Only the roles that may request
 * or approve the void (`M-1`: TRE and ADJL, read from the register so the two
 * cannot drift); every other operator sees `null` there, and the rest of the
 * row unchanged. The approvals inbox and the feed stay readable by any
 * operator; the buyer-debt list itself is already TRE/ADJL only.
 */
export function mayReadDebtVoidResult(roles: readonly string[]): boolean {
  const readers = lookupOverride(DEBT_VOID_CODE)?.roles ?? [OperatorRole.TRE, OperatorRole.ADJL];
  return readers.some((role) => roles.includes(role));
}
