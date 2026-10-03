/**
 * The transaction helper was never ledger-specific — the evidence pack is sealed
 * in the same shape — so it lives in `@shared/database/transaction.util`
 * now. This alias keeps the ledger's eight call sites reading in their own
 * vocabulary rather than churning them for a rename.
 */
export {
  runInTransaction as runInLedgerTransaction,
  isRetryable,
  TRANSACTION_ATTEMPTS as LEDGER_TRANSACTION_ATTEMPTS,
} from '@shared/database/transaction.util';
