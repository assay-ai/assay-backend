import { ChainId } from './caip.types';
import { Money } from './money.types';

/**
 * The parameters a settlement deployment holds on chain (EVM `AssayConfig`):
 * `params()`, `slashDelaySeconds()`, `collectHoldSeconds()`, `paused()` and
 * `arbiter()`, plus the deployment's contract addresses.
 *
 * The chain is the source of truth for every one of them. `source` says where
 * THIS copy came from:
 *
 * - `'chain'`: the last successful read (`readAt`). Every field is the chain's,
 *   whatever the env says, in both directions.
 * - `'config'`: the chain was never read in this process. The fields that have
 *   an env fallback carry it (`PROVIDER_MINIMUM_STAKE_FLOOR`,
 *   `PLATFORM_FEE_BPS`, `PROVIDER_TERMS_PENALTY_SPLIT`,
 *   `CALL_DISPUTE_HOLD_WINDOW_MINUTES`, `SLASH_TIMELOCK_HOURS`); the rest are
 *   `null`.
 */
export interface ChainParams {
  readonly chainId: ChainId;
  readonly source: 'chain' | 'config';
  readonly readAt: Date | null;
  readonly contracts: {
    readonly config: `0x${string}`;
    readonly stake: `0x${string}`;
    readonly escrow: `0x${string}`;
    readonly asset: `0x${string}`;
  };
  readonly minimumStake: Money | null;
  /** The most one attestation (one record) can slash. */
  readonly penaltyAmount: Money | null;
  readonly verifierDailyCap: Money | null;
  readonly takeRateBps: number | null;
  readonly slashAgentBps: number | null;
  readonly slashPlatformBps: number | null;
  /** Per provider, per rolling 24 h, of the stake at risk. */
  readonly slashCapBps: number | null;
  readonly unbondingPeriodSeconds: number | null;
  /** `slashDelaySeconds()`: the delay a proposal made now freezes. */
  readonly slashDelaySeconds: number | null;
  /**
   * The off-chain floor under it (`SLASH_TIMELOCK_HOURS`, a policy the slash
   * lifecycle and a database check enforce). The effective delay a provider
   * gets is the larger of the two.
   */
  readonly policySlashDelaySeconds: number;
  /** `collectHoldSeconds()`: the dispute hold every held payment freezes. */
  readonly collectHoldSeconds: number | null;
  readonly paused: boolean | null;
  readonly arbiter: `0x${string}` | null;
}

/**
 * One in-memory copy of {@link ChainParams} per settlement deployment, per
 * process: read at boot, every 5 minutes, and again as soon as the chain-state
 * indexer records a config-change event (`ConfigUpdated`, `SlashDelaySet`,
 * `CollectHoldSet`, `ArbiterSet`). Reads are synchronous and never wait for a
 * chain.
 */
export interface ChainParamsPort {
  /** The copy for `chainId`, or `null` when this process has no deployment for it. */
  current(chainId: ChainId): ChainParams | null;
  /** Every deployment's copy, in deployment order. */
  all(): readonly ChainParams[];
  /** Read every chain again now. Never rejects; one run at a time. */
  refresh(): Promise<void>;
  /** Called after a read changed a chain's values. Returns the unsubscribe. */
  subscribe(listener: (params: ChainParams) => void): () => void;
}

export const CHAIN_PARAMS = 'CHAIN_PARAMS';
