import { ChainId } from '@modules/chains/ports/caip.types';

/**
 * The on-chain limits a pro-rata plan must fit inside, read live.
 *
 * Every figure is the contract's own, in minor units of the staked asset, and
 * none is enforced here: the contract enforces all of them itself. They are
 * read so the plan can be **scaled** to fit before anything is signed, rather
 * than have one agent's part refused (`PenaltyExceedsMaximum`) or reserved
 * short while another's is paid in full.
 */
export interface SlashCaps {
  /** `params.penaltyAmount` — the largest `penalty` one attestation may carry. */
  readonly penaltyCeilingMinor: bigint;
  /** `(bonded + unbonding) × slashCapBps / 10⁴` — `capAllowance` as `proposeSlash` computes it. */
  readonly windowAllowanceMinor: bigint;
  /** `(bonded + unbonding) − pendingSlash` — what other standing judgements have not reserved. */
  readonly freeStakeMinor: bigint;
  /**
   * `pendingSlash` — every standing (`Pending` or `Disputed`) record's
   * reservation, this platform's or not. Already subtracted in
   * `freeStakeMinor`; never counted against the window, which only
   * executions consume (review 2026-10-24 wave 2 M-1). Kept for the log.
   */
  readonly pendingSlashMinor: bigint;
  /**
   * `params.verifierDailyCap`. Kept in the ParamSet, but no longer applied by
   * `executeSlash` (review 2026-10-23 M-1): read for display only, never a
   * ceiling a plan or a keeper waits on.
   */
  readonly verifierDailyCapMinor: bigint;
  /** `params.slashAgentBps` / `slashPlatformBps`, for the dust floor and the report. */
  readonly agentBps: number;
  readonly platformBps: number;
}

export interface SlashCapsReaderPort {
  readCaps(request: { readonly chainId: ChainId; readonly provider: string }): Promise<SlashCaps>;
}

export const SLASH_CAPS_READER = 'SLASH_CAPS_READER';
