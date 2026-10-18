import { Inject, Injectable, Logger } from '@nestjs/common';

import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { AccountId, AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import {
  ESCROW_INTENT_BUILDER,
  EscrowIntentBuilderPort,
} from '@modules/settlement/ports/escrow-intent-builder.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { ESCROW_WINDOW_SECONDS } from '../constants/escrow-account.constants';
import { SettlementErrors } from '../errors/settlement.errors';

/**
 * The buyer's escrow, as one object — the balance,
 * both brakes, the window meter, and any pending withdrawal as a
 * server-supplied instant.
 *
 * **Every chain-derived field is nullable, and `chainReadable` is what says
 * why.** `null` with `chainReadable: true` is the chain's own answer (no
 * escrow at those seeds, no withdrawal pending); `null` with
 * `chainReadable: false` is *unknown*. The two must never render the same,
 * which is why `exists` is `boolean | null` rather than a `false` that would
 * tell a buyer they have no escrow on the strength of a read that never
 * happened.
 */
export interface EscrowState {
  /**
   * Whether this buyer's escrow has ever been opened — `null` when
   * `chainReadable` is false, because *"we could not look"* is not *"there is
   * nothing there"*.
   */
  readonly exists: boolean | null;
  readonly account: AccountId;
  readonly escrowPda: AccountId | null;
  readonly escrowTokenAccount: AccountId | null;
  readonly balance: Money | null;
  readonly openHolds: Money | null;
  readonly spendable: Money | null;
  readonly withdrawRequested: Money | null;
  /** A SERVER-SUPPLIED ISO-8601 INSTANT, never a delay. `null` when nothing is pending. */
  readonly withdrawAvailableAt: string | null;
  /** The server's own clock at the moment it answered, so a client can render a countdown. */
  readonly serverTime: string;
  /** `null` only when the chain could not even say which delay applies. */
  readonly withdrawDelaySeconds: number | null;
  readonly maxVoucherAmount: Money | null;
  readonly maxPerWindow: Money | null;
  readonly spentInWindow: Money | null;
  readonly windowStartedAt: string | null;
  readonly windowSeconds: number;
  /** `BuyerEscrow.seq_high`. `null` when the chain could not be read — never `'0'`, which is a fact. */
  readonly seqHigh: string | null;
  readonly nextSeq: string;
  /** When the reading was taken. `null` when there was no reading. */
  readonly observedAt: string | null;
  /**
   * False when the chain could not be read on this request, in which case
   * every chain-derived field above is `null` because it is **unknown**, not
   * zero and not absent. The database facts (`escrowPda`,
   * `escrowTokenAccount`, `nextSeq`) are unaffected and are still served.
   *
   * The same `chainReadable: false` idiom the provider capital screen uses
   * (`provider/dto/get-provider-stake.dto.ts`) and the spend-policy velocity
   * meter mirrors — deliberately the same word, so a console renders "—" for
   * the same reason on every screen.
   */
  readonly chainReadable: boolean;
  /**
   * Lifetime money in and out of this escrow, as the chain counts it:
   * `deposited − spent − withdrawn = balance` holds by the contract's own
   * invariant. `null` when the chain keeps no such counters (Solana), has no
   * escrow, or could not be read. Display only.
   */
  readonly lifetime: EscrowLifetime | null;
}

/** See {@link EscrowState.lifetime}. `spent` includes payments still in their dispute hold. */
export interface EscrowLifetime {
  readonly deposited: Money;
  readonly spent: Money;
  readonly withdrawn: Money;
}

/**
 * Reads a buyer's escrow, whole.
 *
 * One route (`GET /escrow`) rather than four, because every field comes from
 * one decode of one account plus one token-account read, and splitting them
 * would be four round trips for one screen.
 *
 * **`withdrawAvailableAt` is an instant, and `serverTime` is beside it.** A
 * client that rendered `now + withdrawDelaySeconds` would be wrong after any
 * `update_config`, and wrong in the direction that promises money sooner than
 * the chain will pay it. The instant is `BuyerEscrow.withdraw_available_at`,
 * which the program froze when the request was made; `serverTime` is here so
 * a countdown does not inherit a skewed browser clock. `withdrawDelaySeconds`
 * is published too, but as information about the *next* request, never as the
 * input to a countdown for the current one.
 *
 * **`0` is reported as `0`, never as "unlimited".** A console that
 * rendered a zero limit as "no limit" would tell a buyer they were
 * unprotected when in fact no call of theirs could be paid at all — this
 * class does not soften that, it publishes the number the chain has.
 *
 * ## Two reads, and only one of them degrades
 *
 * ```text
 * get(org, account, asset)        FAILS CLOSED — the money path's read
 * getForConsole(org, account)     DEGRADES to chainReadable: false — the screen's read
 * ```
 *
 * `get` is what `WithdrawalService.buildIntent` snapshots beside the bytes it
 * built, and it still propagates `PAYMENT_ESCROW_BALANCE_UNAVAILABLE` as a
 * 503 rather than serving a picture that might already be wrong.
 *
 * `getForConsole` is `GET /escrow`. It answers the same question the capital
 * screen answers when an RPC is down, and for the same reasons
 * (`ProviderStakeService.readChain`): a buyer opening this screen during a
 * chain incident is precisely the buyer who needs an answer, the endpoint
 * takes no money decision, and the unknown stays visible rather than being
 * rounded to zero. **It is not a stale picture** — the fields it cannot read
 * are `null`, not last-known — so the "fails closed, not stale" decision
 * `get` encodes is kept, not reversed.
 *
 * The degrading `catch` wraps **exactly the two chain calls** and nothing
 * else, so it cannot swallow a Postgres outage and report it as an
 * unreadable chain. That is deliberate and is why the chain read is not
 * inside `Promise.all` with the database reads any more: a `catch` around a
 * combined promise answers a different question than the one it is named for.
 * The cost is one round trip of latency on this screen, paid to keep the
 * failure attributions honest.
 *
 * **`openHolds` / `spendable` are computed here, not read from
 * `EscrowSpendGateService`.** That service's own `Spendable` type is trimmed
 * to what `assertAffordable` needs (`docs`: "the whole struct is carried" is
 * `EscrowChainBalance`'s promise, not `Spendable`'s) — this class needs the
 * limits and the window meter too, so it reads the full account once and does
 * the same "chain minus open holds, floored at zero" arithmetic
 * `EscrowSpendGateService.netOfHolds` does, rather than depending on a type
 * that would have to grow to carry fields this screen needs and the spend
 * gate does not.
 */
@Injectable()
export class EscrowAccountService {
  private readonly logger = new Logger(EscrowAccountService.name);

  constructor(
    @Inject(ESCROW_BALANCE_READER) private readonly reader: EscrowBalanceReaderPort,
    private readonly holds: LedgerHoldRepository,
    private readonly escrows: BuyerEscrowRepository,
    @Inject(ESCROW_INTENT_BUILDER) private readonly builder: EscrowIntentBuilderPort,
  ) {}

  /**
   * `Config.stake_mint` as a CAIP-19 asset — the escrow's own mint, read from
   * the chain. The controller resolves this before `WithdrawalService.buildIntent`,
   * which takes no asset opinion of its own.
   *
   * **Refuses by name.** A chain that cannot be read here used to surface as
   * whatever the decoder happened to throw — a 500 carrying
   * `CHAIN_ACCOUNT_LAYOUT_UNEXPECTED` and a codec message — on all three
   * `*-intent` routes. The routes cannot degrade: every one of them names the
   * mint in the transaction the buyer is asked to sign, and a guessed mint is
   * a `withdraw` aimed at the wrong token account. So they refuse, and
   * `SETTLEMENT_ESCROW_CHAIN_UNREADABLE` is what they refuse with — one code a
   * console can render and an operator can alert on, with the underlying
   * failure kept in `reason`.
   */
  async assetFor(account: AccountId): Promise<AssetId> {
    try {
      const { asset } = await this.builder.escrowAsset(account);
      return asset;
    } catch (error) {
      throw SettlementErrors.escrowChainUnreadable({ account, reason: describe(error) });
    }
  }

  /**
   * `GET /escrow` — the console's read, which renders whatever it can.
   *
   * See the class comment for why this one degrades and {@link get} does not.
   */
  async getForConsole(organizationId: string, account: AccountId): Promise<EscrowState> {
    let asset: AssetId;
    let reading: EscrowChainBalance | null;

    try {
      asset = await this.assetFor(account);
      reading = await this.reader.read(account, asset);
    } catch (error) {
      // Logged rather than raised — the same trade `ProviderStakeService.readChain`
      // makes, and the same log level, so one grep finds both.
      this.logger.warn(
        `Could not read the escrow chain for ${account}; serving GET /escrow without its ` +
          `chain-derived fields: ${describe(error)}`,
      );
      return this.unreadable(organizationId, account);
    }

    return this.assemble(organizationId, account, asset, reading);
  }

  /**
   * The escrow as of one chain reading, or a 503 if there is no reading to be
   * had. **Fails closed, not stale** — `EscrowBalanceReaderPort.read` already
   * fails closed past its 60s ceiling and this method does not catch
   * that.
   */
  async get(organizationId: string, account: AccountId, asset: AssetId): Promise<EscrowState> {
    const reading = await this.reader.read(account, asset);
    return this.assemble(organizationId, account, asset, reading);
  }

  /** The whole response, given a chain reading (or the chain's own "no such account"). */
  private async assemble(
    organizationId: string,
    account: AccountId,
    asset: AssetId,
    reading: EscrowChainBalance | null,
  ): Promise<EscrowState> {
    const [withdrawDelaySeconds, nextSeq, mirror] = await Promise.all([
      // The account's own chain. The delay is a per-chain quantity —
      // read off `Config` on Solana, a compile-time constant on eip155 — and a
      // screen showing one chain's countdown for the other is a wrong number a
      // buyer would act on.
      this.builder.withdrawDelaySeconds(chainIdOf(account)),
      this.escrows.peekNextSeq(organizationId, account),
      this.escrows.findByAccount(organizationId, account),
    ]);

    const now = new Date();
    const nextSeqStr = nextSeq === null ? '0' : nextSeq.toString();
    const escrowPda = (mirror?.escrowAccountId as AccountId | undefined) ?? null;
    const escrowTokenAccount = (mirror?.escrowAssetAccountId as AccountId | undefined) ?? null;

    if (!reading) {
      return {
        exists: false,
        account,
        escrowPda,
        escrowTokenAccount,
        balance: null,
        openHolds: null,
        spendable: null,
        withdrawRequested: null,
        withdrawAvailableAt: null,
        serverTime: now.toISOString(),
        withdrawDelaySeconds,
        maxVoucherAmount: null,
        maxPerWindow: null,
        spentInWindow: null,
        windowStartedAt: null,
        windowSeconds: ESCROW_WINDOW_SECONDS,
        seqHigh: '0',
        nextSeq: nextSeqStr,
        observedAt: now.toISOString(),
        // The chain answered. It said there is no escrow at those seeds, which
        // is a fact about the escrow and not a failure to read one.
        chainReadable: true,
        lifetime: null,
      };
    }

    const decimals = reading.balance.decimals;
    const openHoldsAtomic = await this.holds.sumOpenByAccount(account, asset);
    const chainAtomic = BigInt(reading.balance.amount);
    const spendableAtomic = chainAtomic > openHoldsAtomic ? chainAtomic - openHoldsAtomic : 0n;

    return {
      exists: true,
      account,
      escrowPda,
      escrowTokenAccount,
      balance: reading.balance,
      openHolds: MoneyUtil.of(openHoldsAtomic, asset, decimals),
      spendable: MoneyUtil.of(spendableAtomic, asset, decimals),
      withdrawRequested: MoneyUtil.of(reading.withdrawRequested, asset, decimals),
      withdrawAvailableAt:
        reading.withdrawRequested > 0n
          ? new Date(reading.withdrawAvailableAt * 1000).toISOString()
          : null,
      serverTime: now.toISOString(),
      withdrawDelaySeconds,
      maxVoucherAmount: MoneyUtil.of(reading.maxVoucherAmount, asset, decimals),
      maxPerWindow: MoneyUtil.of(reading.maxPerWindow, asset, decimals),
      spentInWindow: MoneyUtil.of(reading.spentInWindow, asset, decimals),
      windowStartedAt:
        reading.windowStartedAt > 0 ? new Date(reading.windowStartedAt * 1000).toISOString() : null,
      windowSeconds: ESCROW_WINDOW_SECONDS,
      seqHigh: reading.seqHigh.toString(),
      nextSeq: nextSeqStr,
      observedAt: reading.observedAt.toISOString(),
      chainReadable: true,
      lifetime: reading.lifetime
        ? {
            deposited: MoneyUtil.of(reading.lifetime.funded, asset, decimals),
            spent: MoneyUtil.of(reading.lifetime.redeemed, asset, decimals),
            withdrawn: MoneyUtil.of(reading.lifetime.withdrawn, asset, decimals),
          }
        : null,
    };
  }

  /**
   * The screen with its chain half missing: every chain-derived field `null`,
   * every database fact still present, and `chainReadable: false` saying which
   * is which.
   *
   * The database reads here are **not** wrapped in a `catch` — a Postgres
   * outage is not an unreadable chain and must not be reported as one.
   */
  private async unreadable(organizationId: string, account: AccountId): Promise<EscrowState> {
    const [nextSeq, mirror] = await Promise.all([
      this.escrows.peekNextSeq(organizationId, account),
      this.escrows.findByAccount(organizationId, account),
    ]);

    const now = new Date();

    return {
      exists: null,
      account,
      escrowPda: (mirror?.escrowAccountId as AccountId | undefined) ?? null,
      escrowTokenAccount: (mirror?.escrowAssetAccountId as AccountId | undefined) ?? null,
      balance: null,
      openHolds: null,
      spendable: null,
      withdrawRequested: null,
      withdrawAvailableAt: null,
      serverTime: now.toISOString(),
      // Still answered where it can be: on Solana this is a program constant
      // and on eip155 a compile-time one, so an unreadable `Config` does not
      // take the next request's waiting time with it.
      withdrawDelaySeconds: await this.withdrawDelayOrNull(account),
      maxVoucherAmount: null,
      maxPerWindow: null,
      spentInWindow: null,
      windowStartedAt: null,
      windowSeconds: ESCROW_WINDOW_SECONDS,
      seqHigh: null,
      nextSeq: nextSeq === null ? '0' : nextSeq.toString(),
      observedAt: null,
      chainReadable: false,
      lifetime: null,
    };
  }

  private async withdrawDelayOrNull(account: AccountId): Promise<number | null> {
    try {
      return await this.builder.withdrawDelaySeconds(chainIdOf(account));
    } catch (error) {
      this.logger.warn(`Could not resolve the withdrawal delay for ${account}: ${describe(error)}`);
      return null;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
