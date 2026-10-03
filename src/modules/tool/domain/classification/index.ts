/**
 * The response classifier.
 *
 * ```text
 * provider responds ──▶ classifyResponse ──┬── SYSTEM_ERROR  → void, stake untouched
 *                                          ├── REQUEST_ERROR → void, stake untouched
 *                                          └── DATA_RESULT   → verification → maybe a slash
 * ```
 *
 * Pure, like the mapping engine next door: no clock (wall time is a parameter),
 * no socket, no repository. That is not tidiness — a disputed call
 * has to be re-classifiable from its stored receipt to the same answer months
 * later, and a classifier that read `Date.now()` or a live policy row could not
 * promise that.
 */

export * from './classification.types';
export * from './response-body';
export * from './transport-error';
export * from './classify';
