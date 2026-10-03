/**
 * Queue names owned by the verification module.
 *
 * Naming convention: `<entity>.<verb>` in kebab-case. See `docs/architecture.md`.
 */
export enum VerificationQueue {
  /**
   * The wakeup for `VerificationSettlementService.judgeAndSettle` — never a
   * payload. The evidence lives in `verification_records`, written durably
   * *before* this is published; the job carries nothing but the ids a worker
   * needs to find that row again. See
   * `docs/adr/0001-bullmq-as-wakeup-mechanism.md`.
   */
  JUDGE = 'verification.judge',
}
