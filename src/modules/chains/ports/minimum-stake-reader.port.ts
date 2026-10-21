import { ChainId } from './caip.types';
import { Money } from './money.types';

/**
 * The minimum stake each settlement contract enforces, read live from the
 * contract's own parameters (EVM `params().minimumStake`): the number the
 * operator Contracts page shows. Read-only, for display; the routing gate
 * keeps its own configured floor.
 */
export interface MinimumStakeReaderPort {
  /** One entry per settlement deployment this process can read; empty when none. */
  readMinimumStakes(): Promise<
    readonly { readonly chainId: ChainId; readonly minimumStake: Money }[]
  >;
}

export const MINIMUM_STAKE_READER = 'MINIMUM_STAKE_READER';
