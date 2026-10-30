import { Logger } from '@nestjs/common';

import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { ChainId } from '../ports/caip.types';
import {
  EVM_HOURLY_WEI_WINDOW_SECONDS,
  EvmHourlyWeiWindow,
  EvmWeiBudgetTicket,
  shareOf,
} from './evm-hourly-wei-budget';

/**
 * How much wei the relayer may spend per hour on sends paid for by a buyer's
 * request (relayed `*BySig` requests and withdraw gas grants), on one chain,
 * across EVERY account and organization. `EVM_RELAYER_HOURLY_SPEND_WEI`;
 * default 0.0002 ETH.
 *
 * In WEI, not in sends (review 2026-10-30 I-2). A count of 120 sends assumed the
 * ordinary 2.3e-6 ETH of a `setLimitsBySig`; during an L1 spike each send costs
 * up to the per-request cap, and 120 of those would empty the 0.001 ETH float
 * several times over. Charged at the estimate (`gasLimit × L2 basefee`, the most
 * a Nitro send can cost) when admitted, and replaced by the actual cost
 * (`gasUsed × basefee`) once a relayed request's receipt is in. A gas grant is
 * charged its value plus its transfer at the quoted fee, and not settled: the
 * value is the cost.
 *
 * The per-account (20) and per-organization (50) limits of
 * `relayed-intent-rate-limit.ts` still bound one tenant; this bounds N of them.
 * Slash sends are not counted: they are the platform's own, and the float is
 * kept for them.
 */
export const EVM_RELAYER_HOURLY_SPEND_WEI_ENV = 'EVM_RELAYER_HOURLY_SPEND_WEI';
export const DEFAULT_EVM_RELAYER_HOURLY_SPEND_WEI = 200_000_000_000_000n; // 0.0002 ETH

/**
 * The RESERVED LANE: a second hourly allowance, on top of
 * {@link DEFAULT_EVM_RELAYER_HOURLY_SPEND_WEI}, that only a request from an
 * account holding at least {@link DEFAULT_EVM_RELAYER_RESERVED_LANE_MIN_BALANCE_ATOMIC}
 * in its escrow (balance, or a pending withdrawal, read on chain) may spend,
 * and only once the shared lane is spent. `EVM_RELAYER_RESERVED_LANE_WEI`;
 * default 0.0001 ETH an hour.
 *
 * Creating accounts costs nothing, and accounts with nothing in escrow can spend
 * the shared lane in an hour. They cannot touch this one, so a real buyer's
 * brake (`setLimitsBySig`) and exit (`requestWithdrawBySig`, the withdraw gas
 * grant) keep a budget no stranger can drain. The two lanes together bound the
 * relayer at 0.0003 ETH an hour by default.
 */
export const EVM_RELAYER_RESERVED_LANE_WEI_ENV = 'EVM_RELAYER_RESERVED_LANE_WEI';
export const DEFAULT_EVM_RELAYER_RESERVED_LANE_WEI = 100_000_000_000_000n; // 0.0001 ETH

/**
 * What an account must hold in its escrow to use the reserved lane, in atomic
 * units of the chain's settlement asset: its balance, or its pending
 * withdrawal, at least this much (review 2026-10-30 I-3, owner decision).
 * `EVM_RELAYER_RESERVED_LANE_MIN_BALANCE_ATOMIC`; default 1,000,000 ($1 of the
 * 6-decimal USDG). "Non-zero" let a 1-atomic dust deposit buy a stranger the
 * lane kept for real buyers.
 */
export const EVM_RELAYER_RESERVED_LANE_MIN_BALANCE_ENV =
  'EVM_RELAYER_RESERVED_LANE_MIN_BALANCE_ATOMIC';
export const DEFAULT_EVM_RELAYER_RESERVED_LANE_MIN_BALANCE_ATOMIC = 1_000_000n;

/**
 * The most of the reserved lane ONE account may spend per hour, in basis points
 * of it (review 2026-10-30 I-3). `EVM_RELAYER_RESERVED_LANE_ACCOUNT_SHARE_BPS`;
 * default 1,000 (10 %). Counted in the same script as the lane, so one funded
 * account cannot take the lane from every other funded one.
 */
export const EVM_RELAYER_RESERVED_LANE_ACCOUNT_SHARE_BPS_ENV =
  'EVM_RELAYER_RESERVED_LANE_ACCOUNT_SHARE_BPS';
export const DEFAULT_EVM_RELAYER_RESERVED_LANE_ACCOUNT_SHARE_BPS = 1_000;

/** DI token: the {@link EvmRelayerHourlyBudget}, or `null` in a process without Redis. */
export const EVM_RELAYER_HOURLY_BUDGET = 'EVM_RELAYER_HOURLY_BUDGET';

/** The window of both lanes. */
export const EVM_RELAYER_HOURLY_WINDOW_SECONDS = EVM_HOURLY_WEI_WINDOW_SECONDS;

/**
 * `assay:evm-relayer-hourly-wei:<chainId>` (shared lane) and
 * `assay:evm-relayer-hourly-wei:reserved:<chainId>`: sorted sets of admitted
 * charges, scored by instant. A new prefix: the count-based budget's members
 * carry no wei, and their names must not be summed as if they did.
 */
export const EVM_RELAYER_HOURLY_KEY_PREFIX = 'assay:evm-relayer-hourly-wei';

export function relayerHourlyKey(chainId: ChainId): string {
  return `${EVM_RELAYER_HOURLY_KEY_PREFIX}:${chainId}`;
}

export function relayerReservedLaneKey(chainId: ChainId): string {
  return `${EVM_RELAYER_HOURLY_KEY_PREFIX}:reserved:${chainId}`;
}

/** `assay:evm-relayer-hourly-wei:reserved:<chainId>:account:<account>`: one account's part of the lane. */
export function relayerReservedLaneAccountKey(chainId: ChainId, account: string): string {
  return `${relayerReservedLaneKey(chainId)}:account:${account.toLowerCase()}`;
}

/** What an account holds in its escrow, in atomic units, for the reserved lane's test. */
export interface EvmRelayerEscrowHolding {
  readonly balance: bigint;
  readonly withdrawRequested: bigint;
}

/** The reserved lane's test: a balance, or a pending withdrawal, of at least `minimum`. */
export function holdsReservedLaneMinimum(
  holding: EvmRelayerEscrowHolding | null,
  minimum: bigint,
): boolean {
  if (!holding) return false;
  return holding.balance >= minimum || holding.withdrawRequested >= minimum;
}

export interface EvmRelayerSpend {
  /** The estimated cost of the send, in wei. */
  readonly wei: bigint;
  /** What the send is, for the log line. */
  readonly purpose: string;
  /** The requesting account, for its part of the reserved lane. */
  readonly account: string;
  /**
   * What the account holds in its escrow, for the reserved lane's test
   * ({@link holdsReservedLaneMinimum}). Lazy: asked only once the shared lane
   * refuses, so an ordinary hour costs no escrow read. `null`, or a read that
   * fails, counts as holding nothing.
   */
  readonly escrow: EvmRelayerEscrowHolding | null | (() => Promise<EvmRelayerEscrowHolding | null>);
}

export interface EvmRelayerHourlyBudgetOptions {
  /** {@link DEFAULT_EVM_RELAYER_RESERVED_LANE_MIN_BALANCE_ATOMIC}. */
  readonly reservedMinBalanceAtomic?: bigint;
  /** {@link DEFAULT_EVM_RELAYER_RESERVED_LANE_ACCOUNT_SHARE_BPS}. */
  readonly reservedAccountShareBps?: number;
}

/**
 * The relayer's global hourly spend budget, per chain, in Redis.
 *
 * Taken immediately before the send, after every check that can refuse, so a
 * refused request costs nothing from it. It fails CLOSED, as the per-account
 * limiter does: an uncountable budget is not a budget.
 */
export class EvmRelayerHourlyBudget {
  private readonly logger = new Logger(EvmRelayerHourlyBudget.name);
  private readonly window: EvmHourlyWeiWindow;
  readonly reservedMinBalanceAtomic: bigint;
  readonly reservedAccountShareBps: number;

  constructor(
    cache: CacheService,
    readonly limitWei: bigint = DEFAULT_EVM_RELAYER_HOURLY_SPEND_WEI,
    readonly reservedWei: bigint = DEFAULT_EVM_RELAYER_RESERVED_LANE_WEI,
    options: EvmRelayerHourlyBudgetOptions = {},
  ) {
    this.window = new EvmHourlyWeiWindow(cache);
    this.reservedMinBalanceAtomic =
      options.reservedMinBalanceAtomic ?? DEFAULT_EVM_RELAYER_RESERVED_LANE_MIN_BALANCE_ATOMIC;
    this.reservedAccountShareBps =
      options.reservedAccountShareBps ?? DEFAULT_EVM_RELAYER_RESERVED_LANE_ACCOUNT_SHARE_BPS;
  }

  /** The most one account may take of the reserved lane in an hour. */
  get reservedAccountWei(): bigint {
    return shareOf(this.reservedWei, this.reservedAccountShareBps);
  }

  /**
   * Charges one send: the shared lane first, then — for an account holding at
   * least the lane's minimum only — the reserved lane, within that account's
   * share of it (lane and share in one script). `null`: over budget, or the sum
   * could not be made.
   */
  async take(chainId: ChainId, spend: EvmRelayerSpend): Promise<EvmWeiBudgetTicket | null> {
    try {
      const shared = await this.window.take(relayerHourlyKey(chainId), spend.wei, this.limitWei);
      if (shared) return shared;
      const funded = this.reservedWei > 0n && (await this.isFunded(spend));
      if (funded) {
        const reserved = await this.window.takeAll([
          { key: relayerReservedLaneKey(chainId), wei: spend.wei, limit: this.reservedWei },
          {
            key: relayerReservedLaneAccountKey(chainId, spend.account),
            wei: spend.wei,
            limit: this.reservedAccountWei,
          },
        ]);
        if (reserved.admitted) {
          this.logger.warn(
            `the relayer's shared hourly budget of ${this.limitWei} wei on ${chainId} is spent; ` +
              `${spend.purpose} (${spend.wei} wei) admitted on the reserved lane`,
          );
          return reserved.ticket;
        }
        if (reserved.refused.some((refusal) => refusal.index === 1)) {
          this.logger.warn(
            `${spend.account} has spent its ${this.reservedAccountWei} wei share of the ` +
              `relayer's reserved lane on ${chainId} this hour; ${spend.purpose} refused`,
          );
        }
      }
      this.logger.warn(
        `the relayer's hourly budget on ${chainId} is spent (${this.limitWei} wei shared` +
          `${funded ? `, ${this.reservedWei} wei reserved` : ''}); ` +
          `${spend.purpose} (${spend.wei} wei) refused`,
      );
      return null;
    } catch (error) {
      this.logger.error(
        `the relayer's hourly budget on ${chainId} could not be counted; ${spend.purpose} refused. ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }

  private async isFunded(spend: EvmRelayerSpend): Promise<boolean> {
    let holding: EvmRelayerEscrowHolding | null;
    try {
      holding = typeof spend.escrow === 'function' ? await spend.escrow() : spend.escrow;
    } catch {
      return false;
    }
    return holdsReservedLaneMinimum(holding, this.reservedMinBalanceAtomic);
  }

  /** The send's receipt is in: its charge becomes what it cost. Never throws. */
  settle(ticket: EvmWeiBudgetTicket, actualWei: bigint): Promise<void> {
    return this.window.settle(ticket, actualWei);
  }
}
