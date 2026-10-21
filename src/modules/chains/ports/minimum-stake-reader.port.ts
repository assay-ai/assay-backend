import { ChainId } from './caip.types';
import { Money } from './money.types';

/** Why a chain gave no minimum stake: no answer within the budget, or an error. */
export type MinimumStakeReadFailure = 'TIMEOUT' | 'UNREADABLE';

/** One chain's reading: the value, or a short failure code (never the raw error). */
export type MinimumStakeReading =
  | { readonly chainId: ChainId; readonly minimumStake: Money; readonly failure: null }
  | {
      readonly chainId: ChainId;
      readonly minimumStake: null;
      readonly failure: MinimumStakeReadFailure;
    };

/**
 * The minimum stake each settlement contract enforces, read live from the
 * contract's own parameters (EVM `params().minimumStake`): the number the
 * operator Contracts page shows. Read-only. The economics panel shows it,
 * and the routing gate raises its configured floor to it when it is stricter
 * (`ContractMinimumStakeFloors`).
 */
export interface MinimumStakeReaderPort {
  /**
   * One reading per settlement deployment this process can read (empty when
   * none), each bounded by `timeoutMs` on its own, so one slow chain neither
   * stalls nor sinks the others. Never rejects; the detail of a failure is
   * logged, not returned.
   */
  readMinimumStakes(options: {
    readonly timeoutMs: number;
  }): Promise<readonly MinimumStakeReading[]>;
}

export const MINIMUM_STAKE_READER = 'MINIMUM_STAKE_READER';
