import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { encodeFunctionData, getAddress, isAddress } from 'viem';

import { EvmGasGrantRepository } from '@database/postgres/repositories/evm-gas-grant.repository';
import {
  GasGrantOutcome,
  GasGrantRefusal,
  WithdrawGasGrantPort,
} from '@modules/settlement/ports/withdraw-gas-grant.port';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { chainMetadata } from '../chain-metadata';
import { EvmEscrowBalanceReader } from './evm-escrow-balance-reader.service';
import { ChainErrors } from '../errors/chains.errors';
import { AccountId, AssetId, ChainId, parseAccountId } from '../ports/caip.types';
import { ASSAY_ESCROW_ABI } from './abi/assay.abi';
import { EVM_RELAYER_FLOAT_LOW_WEI } from './evm-relayer-float.constants';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from './evm.constants';
import { EVM_RELAYER, EvmRelayerPort } from './ports/evm-relayer.port';
import { EVM_RELAYER_HOURLY_BUDGET, EvmRelayerHourlyBudget } from './evm-relayer-hourly-budget';
import { isInsufficientFunds, isSendRejected } from './evm-send-rejected.error';

/**
 * The four read calls this service makes, and **no send**.
 *
 * The send goes through {@link EvmRelayerPort.sendValue}, which is the only door
 * it is allowed to use. Declaring the client without `sendRawTransaction` is the
 * same structural guarantee `EvmEscrowIntentBuilder` makes: a class that cannot
 * reach a send cannot acquire the capability by accident.
 */
export interface EvmGasGrantClient {
  estimateGas(args: {
    account: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
  }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
  /**
   * The chain's own clock, and the fourth read.
   *
   * Declared here for the same reason `EvmEscrowIntentClient` declares it:
   * `AssayEscrow.withdraw()` decides maturity on `block.timestamp`, so the only
   * clock that can be right about whether this buyer's exit is ready is the
   * chain's. See control 2 in {@link EvmGasGrantService.grantNow}.
   */
  getBlock(args: { blockTag: 'latest' }): Promise<{ timestamp: bigint }>;
  /** The account's code: `undefined` or `0x` for a plain EOA. See control 3b. */
  getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
}

/**
 * Both live in `@modules/settlement/ports/withdraw-gas-grant.port`, because the
 * grant acquired its first production caller and a settlement service has to be
 * able to name its outcome.
 *
 * Re-exported rather than left behind as a second declaration: there is one
 * `GasGrantRefusal` in the codebase, and every existing importer of these two
 * names — the specs, `evm.module.ts` — resolves to it through here exactly as
 * before. See the port's file header for why the vocabulary is not duplicated
 * and translated.
 */
export { GasGrantRefusal };
export type { GasGrantOutcome };

export interface EvmGasGrantCaps {
  readonly perGrantMaxWei: bigint;
  readonly dailyMaxWei: bigint;
  readonly relayerFloatLowWaterWei: bigint;
}

export interface EvmGasGrantConfig {
  /**
   * Milliseconds, `Date.now()`'s own unit — and **the daily window's clock, not
   * the maturity gate's**.
   *
   * `grantedWeiSince` compares against `evm_gas_grants.created_at`, which
   * Postgres stamps from the server's clock; measuring that window against a
   * chain's `block.timestamp` would compare two unrelated rulers. Maturity is
   * the opposite case and reads the chain — see control 2.
   */
  readonly now: () => number;
}

export const EVM_GAS_GRANT_CAPS = 'EVM_GAS_GRANT_CAPS';
export const EVM_GAS_GRANT_CONFIG = 'EVM_GAS_GRANT_CONFIG';

export const EVM_GAS_GRANT_MAX_WEI_ENV = 'EVM_RELAYER_GAS_GRANT_MAX_WEI';
export const EVM_GAS_GRANT_DAILY_MAX_WEI_ENV = 'EVM_RELAYER_GAS_GRANT_DAILY_MAX_WEI';
/**
 * The float low-water mark, **re-exported rather than re-typed**.
 *
 * The grant refuses below this mark and `EvmRelayerFloatMonitor` alerts on it.
 * Two config keys with one meaning drift, and this drift is silent in the worst
 * direction: the grant keeps paying out below a level nobody is watching. There
 * is exactly one string literal, in `evm-relayer-float.constants.ts`, and
 * `evm-relayer-float.spec.ts` asserts these two symbols are equal — so
 * re-typing the literal here is what the test catches.
 */
export const EVM_RELAYER_FLOAT_LOW_WATER_ENV = EVM_RELAYER_FLOAT_LOW_WEI;

/** `withdraw()` — the selector is `0x3ccfd60b`, derived here rather than typed. */
const WITHDRAW_CALLDATA = encodeFunctionData({
  abi: ASSAY_ESCROW_ABI,
  functionName: 'withdraw',
}) as `0x${string}`;

/** 24 hours, in milliseconds — the daily cap's window. */
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long a durable reservation holds an address before another process may
 * take it over. Fifteen minutes.
 *
 * The lease exists because a holder that dies between claiming and recording
 * would otherwise lock that buyer out of the grant **forever** — a worse
 * failure than the double-send it is there to prevent, and a permanent one.
 *
 * **It bounds a crash; it does not prove a send is over.** `EvmRelayer`
 * serialises sends per chain and `waitForTransactionReceipt` carries no
 * timeout, so no finite lease can be safe by construction. Fifteen minutes is
 * chosen to sit far above any send this path has been measured making (a
 * receipt on 46630 is seconds) while still being a wait a buyer can sit out.
 * A takeover is therefore always worth looking at, and is logged at `error`.
 */
export const EVM_GAS_GRANT_RESERVATION_LEASE_MS = 15 * 60 * 1000;

const DECIMAL_WEI = /^[0-9]+$/;

/**
 * The three bounds, read from configuration with **no defaults**.
 *
 * An unset cap is a boot failure, not an unlimited faucet: a `?? DEFAULT` here
 * is a faucet whose size nobody chose, and it would be discovered by reading the
 * float rather than by reading a config file.
 *
 * No error message quotes the value it failed to parse (`docs/architecture.md`
 * §"Signing Keys" rule 6). These particular values are not secrets; the rule is
 * about the habit, and a parser that echoes its input is one config key away
 * from echoing a key.
 */
export function parseGasGrantCaps(
  perGrantMaxWei: string | undefined,
  dailyMaxWei: string | undefined,
  relayerFloatLowWaterWei: string | undefined,
): EvmGasGrantCaps {
  const caps = {
    perGrantMaxWei: positiveWei(perGrantMaxWei, EVM_GAS_GRANT_MAX_WEI_ENV),
    dailyMaxWei: positiveWei(dailyMaxWei, EVM_GAS_GRANT_DAILY_MAX_WEI_ENV),
    relayerFloatLowWaterWei: positiveWei(relayerFloatLowWaterWei, EVM_RELAYER_FLOAT_LOW_WATER_ENV),
  };

  // A daily cap below the per-grant cap means the first grant of the day is
  // always refused: the feature is off, and nothing reports that it is.
  if (caps.dailyMaxWei < caps.perGrantMaxWei) {
    throw ChainErrors.configValueInvalid({
      variable: EVM_GAS_GRANT_DAILY_MAX_WEI_ENV,
      accepted: `a daily cap at least as large as ${EVM_GAS_GRANT_MAX_WEI_ENV}; below it every grant is refused`,
    });
  }

  return caps;
}

function positiveWei(value: string | undefined, variable: string): bigint {
  if (value === undefined || !DECIMAL_WEI.test(value)) {
    throw ChainErrors.configValueInvalid({
      variable,
      accepted: 'a positive whole number of wei, in decimal, with no unit and no 0x prefix',
    });
  }

  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw ChainErrors.configValueInvalid({
      variable,
      accepted: 'a positive whole number of wei — zero disables the grant without saying so',
    });
  }

  return parsed;
}

/**
 * The bounded, recorded, one-shot `withdraw` gas grant.
 *
 * ## The problem this exists for
 *
 * `AssayEscrow.withdraw()` is `msg.sender`-only, pays `msg.sender`, and there is
 * no `withdrawBySig` **by design**: the owner is the only party who can take
 * money out, which is exactly what makes a hardware wallet a sufficient upgrade
 * later and what makes a full leak of every env-held key cost the ETH float and
 * nothing else. The price of that property is that **a buyer who deposits USDG
 * and holds no ETH has no exit at all** — a mainnet blocker. The answer: the
 * relayer may fund the buyer's address with exactly the gas for one `withdraw`
 * — a bounded, auditable, capped transfer with its own alert, and it can never
 * become a way to move USDG.
 *
 * ## Who calls this
 *
 * `WithdrawalService.buildIntent`, on `POST /escrow/withdrawals/intent` and on
 * nothing else, through `WITHDRAW_GAS_GRANT`. The call sits *after* the intent
 * builder has produced bytes, which is what makes control 2 below cheap: the
 * builder enforces the same matured-withdrawal precondition and throws
 * `SETTLEMENT_WITHDRAWAL_NOT_YET_AVAILABLE` when it does not hold, so the
 * once-ever budget is never spent on a buyer who ends up with no transaction.
 *
 * ## The six controls, and which one is the bound
 *
 * 1. **`uniq_evm_gas_grants_account`** — one grant per address, ever. This is
 *    the bound. Everything below is a second line, and without the index they
 *    are a rate limit on a faucet.
 * 2. **A matured withdrawal** is required, judged on the **chain's** clock.
 *    The grant is for an exit that is ready, not for a buyer who might want one.
 *    `withdrawRequested > 0` alone would fund an address whose `withdraw()`
 *    reverts for another hour, and `Date.now()` — what this read until the
 *    clock was moved — would make that judgement on a ruler the contract does
 *    not use. See the comment at the check for why a second *reading* of the
 *    chain is not the disagreement a second *clock* was.
 *
 *    With both on the chain's clock, `NO_MATURED_WITHDRAWAL` is once again
 *    **unreachable through this grant's only production caller** — the builder
 *    enforces every one of its three sub-conditions one line earlier and 409s.
 *    It is deliberately kept rather than deleted: it is still produced when two
 *    RPC nodes at different heights answer the builder and this, and a faucet's
 *    controls may not be conditional on which caller reached it.
 * 3. **Two caps with no defaults** — see {@link parseGasGrantCaps}.
 * 4. **A relayer float floor.** The float pays for relayed buyer requests and
 *    slash sends too, and a grant that empties it stops those — a worse failure
 *    than one buyer waiting. (Redemptions are paid by the separate redeemer key.)
 * 5. **An alert on every grant**, not on a threshold. The float moving is the
 *    event; a threshold would make the first N invisible.
 * 6. **A durable reservation**, taken immediately before the send, so two
 *    processes cannot both reach it. See "The concurrency window" below: the
 *    unique index settles the ledger after the fact, and this is what stops the
 *    float paying twice on the way there.
 *
 * ## And one that is structural rather than checked
 *
 * The only door out of this class is {@link EvmRelayerPort.sendValue}, and
 * `EvmValueTransfer` **has no calldata field**. There is no argument a token
 * transfer could be put in, so no reviewer has to establish that nobody did it.
 * `sendCall` — the door that does take calldata — is not named anywhere in this
 * file, and `evm-gas-grant.spec.ts` asserts that at the source level.
 *
 * ## The concurrency window, and how it is closed
 *
 * Two calls in one process are serialised per account by {@link queues}, so the
 * second sees the first's row. Two calls in **two processes** used to both pass
 * every pre-check and both send: one row survived the unique index, so the
 * ledger stayed honest while the float paid twice. The index cannot close that
 * on its own, because a grant row needs a transaction hash and the hash needs
 * the money to have left already.
 *
 * `evm_gas_grant_reservations` closes it — a second table, because the fix that
 * fits in the first one is a nullable `transaction_hash`, and that is a row
 * asserting the relayer sent gas while nothing has been sent. A reservation
 * claims *"an attempt for this address started and has not finished"*, which is
 * true when it is written. The claim is one `INSERT … ON CONFLICT DO UPDATE …
 * WHERE reserved_at < now() - lease`, taken immediately before the send and
 * after every free refusal, so exactly one of two racing processes sends and the
 * other is refused {@link GasGrantRefusal.GRANT_IN_FLIGHT} — a transient
 * refusal, never `ALREADY_GRANTED`, because nothing has been granted.
 *
 * What is left is a **crash**, not a race: a holder that dies between claiming
 * and recording keeps the address locked until
 * {@link EVM_GAS_GRANT_RESERVATION_LEASE_MS} expires, and the retry that
 * follows can pay a second time if the first send had in fact landed. The loss
 * is still bounded by the per-grant cap and by the daily cap in aggregate, and
 * it now needs a fifteen-minute stall rather than a millisecond of concurrency.
 */
@Injectable()
export class EvmGasGrantService implements WithdrawGasGrantPort {
  private readonly logger = new Logger(EvmGasGrantService.name);

  /**
   * One in-flight grant per account, serialised.
   *
   * The same shape `EvmRelayer` uses for nonces, and for a related reason: a
   * `hasGranted` that returned false followed by an unguarded send is two
   * transfers when two requests race. This closes the in-process half; the
   * unique index closes the durable half. See the class comment for what is
   * left.
   */
  private readonly queues = new Map<AccountId, Promise<unknown>>();

  constructor(
    private readonly grants: EvmGasGrantRepository,
    /**
     * The **EVM** reader by class, not `ESCROW_BALANCE_READER`.
     *
     * Two reasons and they point the same way. `ESCROW_BALANCE_READER` is the
     * namespace multiplexer, provided by `ChainsModule`, which imports this
     * module — injecting it here is a cycle. And it would be wrong even if it
     * resolved: this service only ever reads an eip155 escrow, so dispatching
     * through a multiplexer would add a branch that can only ever take one path
     * and would let a Solana account reach a grant that cannot be paid on
     * Solana.
     */
    private readonly escrow: EvmEscrowBalanceReader,
    @Inject(EVM_RELAYER) private readonly relayer: EvmRelayerPort,
    @Inject(EVM_RPC_CLIENTS) private readonly clients: ReadonlyMap<ChainId, EvmGasGrantClient>,
    @Inject(EVM_DEPLOYMENTS) private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(EVM_GAS_GRANT_CAPS) private readonly caps: EvmGasGrantCaps | null,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(EVM_GAS_GRANT_CONFIG) private readonly config: EvmGasGrantConfig,
    /**
     * The relayer's global hourly spend budget, shared with relayed requests.
     * Absent: not checked.
     */
    @Optional()
    @Inject(EVM_RELAYER_HOURLY_BUDGET)
    private readonly hourly: Pick<EvmRelayerHourlyBudget, 'take'> | null = null,
  ) {}

  /**
   * Fund exactly one `withdraw`, once, for this buyer.
   *
   * `organizationId` is a parameter and not derived from the account, because
   * `evm_gas_grants` is an organization-scoped table like every other business
   * table and `OrganizationScopedRepository` refuses an unscoped write.
   * It is **not** part of the once-ever key: the bound is on the ADDRESS, and
   * scoping it would give an attacker who can create organizations one grant per
   * organization to the same address.
   */
  async grantWithdrawGas(organizationId: string, account: AccountId): Promise<GasGrantOutcome> {
    const previous = this.queues.get(account) ?? Promise.resolve();
    const result = previous.then(
      () => this.grantNow(organizationId, account),
      () => this.grantNow(organizationId, account),
    );
    this.queues.set(
      account,
      result.catch(() => undefined),
    );
    return result;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async grantNow(organizationId: string, account: AccountId): Promise<GasGrantOutcome> {
    const { chainId, address } = this.parse(account);
    const deployment = this.deployment(chainId);
    const caps = this.requireCaps();

    // 1. The bound. A cheap read of the unique index's column; the index itself
    //    is what settles a race, and `insert` below maps its violation here.
    if (await this.grants.hasGranted(account)) {
      return refuse(GasGrantRefusal.ALREADY_GRANTED);
    }

    const client = this.client(chainId);

    /*
      2. A matured exit, not a possible one — on the CHAIN's clock.

      `AssayEscrow.withdraw()` reads `if (block.timestamp < e.withdrawAvailableAt)
      revert WithdrawNotYetAvailable()`. The chain is therefore the authority on
      whether this buyer's exit is ready, and `Date.now()` — which this control
      used until now — is a proxy for it that can be arbitrarily wrong: on the
      local fork the two were measured **4,418 seconds apart**. While the builder one
      line earlier read the chain and this read the wall clock, the two
      disagreed for the whole width of that skew, and the buyer was told
      `NO_MATURED_WITHDRAWAL` for a withdrawal the contract would have paid.

      ## Why a SECOND reading of the chain is safe where a second CLOCK was not

      This is not the builder's reading; it is another one, taken a round trip
      later. That is sound in the one direction that matters, because block
      timestamps are monotonically non-decreasing: a reading taken later cannot
      be smaller than the builder's, so this control cannot refuse a maturity the
      builder just accepted. A wall clock carries no such relationship — it can
      sit hours behind the chain and stay there.

      The residual is two RPC nodes at different heights behind one URL
      answering the two calls, with this one on the lagging node. That window is
      a block or two rather than a clock skew, it fails toward REFUSING (a retry,
      and none of the once-ever budget), and it is the same residual the builder
      already names for its own `estimateGas`.

      ## And why it is issued here

      With `escrowOf`, in one `Promise.all` — the shape `buildIntent` uses for
      the same pair. The fourth read costs a concurrent RPC call and no extra
      wall time, which is what the earlier "a fourth round trip" objection was
      about.
    */
    const [reading, chainSeconds] = await Promise.all([
      this.escrow.read(account, chainMetadata(chainId).settlementAsset as AssetId),
      this.chainSeconds(client),
    ]);
    if (
      !reading ||
      reading.withdrawRequested <= 0n ||
      chainSeconds < BigInt(reading.withdrawAvailableAt)
    ) {
      return refuse(GasGrantRefusal.NO_MATURED_WITHDRAWAL);
    }

    const escrowAddress = getAddress(deployment.escrow);

    const [fees, gas, buyerBalance, code] = await Promise.all([
      client.estimateFeesPerGas(),
      client.estimateGas({
        account: address,
        to: escrowAddress,
        data: WITHDRAW_CALLDATA,
        value: 0n,
      }),
      client.getBalance({ address }),
      client.getCode({ address }),
    ]);

    // 3b. Only a plain EOA. A contract or an EIP-7702-delegated account can make
    //     the bare 21 000-gas transfer revert every time, and a reverted grant
    //     burns the relayer's gas while leaving the once-ever budget intact — an
    //     unbounded loop on the relayer float (review 2026-10-15 P-7).
    if (code !== undefined && code !== '0x') {
      return refuse(GasGrantRefusal.ACCOUNT_HAS_CODE);
    }

    // What one `withdraw` costs at the fee the chain is quoting right now.
    const cost = gas * fees.maxFeePerGas;
    // The grant. 20 % margin, for the reason `EvmEscrowIntentBuilder` states at
    // its own: `withdraw` makes an ERC-20 transfer whose cost depends on the
    // token's own state, so the estimate is a floor rather than an answer, and a
    // transaction that runs out of gas has still spent it.
    const wei = (cost * 12n) / 10n;

    // 3. A buyer who can already pay for their own exit does not need one. The
    //    comparison is against the raw cost, not the margined grant: someone who
    //    can send the transaction is not stuck, and topping them up to a nicer
    //    number would spend the once-ever budget on a buyer who had no problem.
    if (buyerBalance >= cost) {
      return refuse(GasGrantRefusal.BUYER_HAS_GAS);
    }

    // 4. A gas spike must make the grant refuse, not make it expensive.
    if (wei > caps.perGrantMaxWei) {
      return refuse(GasGrantRefusal.ABOVE_PER_GRANT_CAP);
    }

    // 5. The cap bounds the total INCLUDING this grant. `sum < cap` would make
    //    the real ceiling `cap + one grant`.
    const grantedToday = await this.grants.grantedWeiSince(
      new Date(this.config.now() - DAILY_WINDOW_MS),
    );
    if (grantedToday + wei > caps.dailyMaxWei) {
      return refuse(GasGrantRefusal.DAILY_CAP_REACHED);
    }

    // 6. …and the float floor bounds what is LEFT after it. `balance >
    //    lowWaterMark` alone leaves the relayer under its own floor the moment
    //    the transfer lands.
    const float = await this.relayer.balanceWei(chainId);
    if (float < caps.relayerFloatLowWaterWei + wei) {
      return refuse(GasGrantRefusal.RELAYER_FLOAT_LOW);
    }

    /*
      7. CLAIM the right to send, durably, before anything is spent.

      Last of the controls and immediately before the send, on purpose: a
      reservation taken earlier would be held by a request that then refuses for
      a cap or the float, locking that address out for a lease for nothing.

      Everything above this line is free to lose a race — two processes both
      reading the same escrow and the same float costs two RPC calls. This is
      the first line where losing one costs money, and it is the line Postgres
      decides rather than this process.
    */
    const reservation = await this.grants.reserveGrant({
      organizationId,
      chainId,
      accountId: account,
      leaseMs: EVM_GAS_GRANT_RESERVATION_LEASE_MS,
    });
    if (!reservation.claimed) {
      // Somebody else is mid-grant for this address. Transient, and deliberately
      // NOT `ALREADY_GRANTED`: the once-ever budget is intact and asking again
      // in a moment is the right thing to do.
      return refuse(GasGrantRefusal.GRANT_IN_FLIGHT);
    }
    if (reservation.takenOver) {
      // An attempt was claimed and never finished. The lease is what stops that
      // locking a buyer out forever; it is not evidence the earlier send is
      // over, so an operator should always see this one.
      this.logger.error(
        `gas grant for ${account} took over a reservation older than ` +
          `${EVM_GAS_GRANT_RESERVATION_LEASE_MS} ms; an earlier attempt never finished`,
      );
    }

    // 7b. The relayer's global hourly spend budget, across every buyer. Taken
    //     only once this grant holds the reservation, so a grant refused above
    //     costs it nothing. Charged the grant's value plus its own 21 000-gas
    //     transfer at the quoted fee. The reserved lane takes it only when the
    //     account passes the lane's own test (review 2026-10-30 I-3): a matured
    //     withdrawal of dust is not "funded". Judged on the escrow read above,
    //     so it costs no further RPC call. Spent: the float cannot cover it now.
    if (
      this.hourly &&
      !(await this.hourly.take(chainId, {
        wei: wei + VALUE_TRANSFER_GAS * fees.maxFeePerGas,
        purpose: 'withdraw gas grant',
        account,
        escrow: {
          balance: BigInt(reading.balance.amount),
          withdrawRequested: reading.withdrawRequested,
        },
      }))
    ) {
      await this.release(account);
      return refuse(GasGrantRefusal.RELAYER_FLOAT_LOW);
    }

    // 8. Send. `sendValue`, and only `sendValue` — see the class comment.
    let sent: Awaited<ReturnType<EvmRelayerPort['sendValue']>>;
    try {
      sent = await this.relayer.sendValue({
        chainId,
        to: account,
        wei,
        purpose: 'withdraw-gas-grant',
      });
    } catch (error) {
      // The node REFUSED it, so it was definitely not broadcast: nothing was
      // funded and the reservation goes back at once. Any other throw leaves
      // the outcome unknown and keeps the reservation (see below).
      if (!isSendRejected(error)) throw error;
      this.logger.error(`gas grant transfer to ${account} was refused: ${error.message}`);
      await this.release(account);
      return refuse(
        isInsufficientFunds(error)
          ? GasGrantRefusal.RELAYER_FLOAT_LOW
          : GasGrantRefusal.TRANSFER_FAILED,
      );
    }

    if (sent.status !== 'SUCCESS') {
      // The chain answered and refused: there is a receipt, and nothing was
      // funded. The address's once-ever budget must still be there — no row is
      // written — and the reservation goes back so the buyer can retry at once
      // rather than waiting out a lease.
      //
      // A send that THREW does not reach here and is deliberately not released.
      // An RPC that stopped answering leaves the outcome UNKNOWN, and releasing
      // on "we did not hear" is how a retry funds an address twice; the lease
      // expiring is the slower, safer version of the same recovery.
      this.logger.error(
        `gas grant transfer failed for ${account}: ${sent.revertReason ?? 'no reason'}`,
      );
      await this.release(account);
      return refuse(GasGrantRefusal.TRANSFER_FAILED);
    }

    try {
      await this.grants.insert({
        organizationId,
        chainId,
        accountId: account,
        wei: wei.toString(),
        transactionHash: sent.hash,
      });
    } catch (error) {
      // The unique index is the arbiter. A violation means somebody else funded
      // this address between the read at step 1 and here — the money has left
      // either way, and reporting a 500 to a buyer for a race the database
      // settled correctly would be the wrong answer twice.
      if (!isUniqueViolation(error)) throw error;
      this.logger.error(
        `gas grant to ${account} raced another grant; the transfer at ${sent.hash} was not recorded`,
      );
      await this.release(account);
      return refuse(GasGrantRefusal.ALREADY_GRANTED);
    }

    // The grants index is the bound from here on, so the reservation has done
    // its job and must not outlive it: a row left behind would make the next
    // reader think an attempt is still in flight.
    await this.release(account);

    // On EVERY grant, and after the row is durable. Never a threshold: the float
    // moving IS the event, and a threshold would make the first N invisible.
    // Failures are swallowed — the money has left and the row is written, and
    // losing either because the alerting channel is down would be worse than a
    // missed page.
    try {
      await this.alerts.emit({
        severity: AlertSeverity.WARN,
        name: 'evm_gas_grant',
        summary: `Granted ${wei} wei of withdraw gas to ${account}`,
        details: {
          account,
          chainId,
          wei: wei.toString(),
          transactionHash: sent.hash,
          organizationId,
          relayerFloatWei: float.toString(),
          dailyGrantedWei: (grantedToday + wei).toString(),
          dailyCapWei: caps.dailyMaxWei.toString(),
        },
        // PER_EVENT, and the dedupe key is here for the journal rather than for
        // suppression: a grant is once-ever per address, so there is no second
        // event to suppress, and a suppressed one would hide the single event
        // this control exists to publish.
        aggregation: AlertAggregation.PER_EVENT,
        dedupeKey: account,
      });
    } catch (error) {
      this.logger.error(`gas grant alert failed for ${account}: ${(error as Error).message}`);
    }

    return { kind: 'GRANTED', hash: sent.hash, wei };
  }

  /**
   * The reading door, applying EIP-55 **strictly**.
   *
   * CAIP-10's grammar is chain-agnostic, so a mixed-case address with a broken
   * checksum satisfies `parseAccountId` — and viem's non-strict `getAddress`
   * downstream then *repairs* it. Here that would mean funding an address nobody
   * verified and filing the row under the repaired spelling, so the once-ever
   * index would not recognise the original. Observed on the adapter's own
   * reading door before it gained the check; every new entry point gets it.
   */
  private parse(account: AccountId): { chainId: ChainId; address: `0x${string}` } {
    const parsed = parseAccountId(account);
    if (!isAddress(parsed.address, { strict: true })) {
      throw ChainErrors.invalidAddress({ address: parsed.address, chainId: parsed.chainId });
    }
    return { chainId: parsed.chainId, address: parsed.address as `0x${string}` };
  }

  /**
   * Hand the reservation back, and never let that be what fails the grant.
   *
   * On every path that calls this the outcome is already decided and, on the
   * successful one, the money has already moved and the row is already durable.
   * Throwing here would turn a completed grant into a 500 over a lock nobody is
   * waiting on — and the lease expires on its own regardless.
   */
  private async release(account: AccountId): Promise<void> {
    try {
      await this.grants.releaseGrantReservation(account);
    } catch (error) {
      this.logger.error(
        `gas grant reservation for ${account} could not be released; it expires in ` +
          `${EVM_GAS_GRANT_RESERVATION_LEASE_MS} ms: ${(error as Error).message}`,
      );
    }
  }

  /** The chain's own clock, in seconds — `block.timestamp` of the latest block. */
  private async chainSeconds(client: EvmGasGrantClient): Promise<bigint> {
    return (await client.getBlock({ blockTag: 'latest' })).timestamp;
  }

  /**
   * The caps, or a refusal naming the variables.
   *
   * `null` when no eip155 chain is enabled — see `evm.module.ts`. Unreachable in
   * practice, because such a deployment has no `EVM_DEPLOYMENTS` entry either
   * and {@link deployment} throws one line earlier; kept because "cannot happen"
   * is a claim about today's wiring and an unguarded `null` here would be a
   * faucet with no bound at all.
   */
  private requireCaps(): EvmGasGrantCaps {
    if (!this.caps) {
      throw ChainErrors.programNotConfigured({
        what: 'the withdraw gas-grant caps',
        variable: `${EVM_GAS_GRANT_MAX_WEI_ENV} and ${EVM_GAS_GRANT_DAILY_MAX_WEI_ENV}`,
      });
    }
    return this.caps;
  }

  private deployment(chainId: ChainId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) throw ChainErrors.unsupportedChain({ chainId });
    return deployment;
  }

  private client(chainId: ChainId): EvmGasGrantClient {
    const client = this.clients.get(chainId);
    if (!client) throw ChainErrors.unsupportedChain({ chainId });
    return client;
  }
}

/** The gas of a plain value transfer, which a grant itself costs the relayer. */
const VALUE_TRANSFER_GAS = 21_000n;

function refuse(reason: GasGrantRefusal): GasGrantOutcome {
  return { kind: 'REFUSED', reason };
}

/**
 * Postgres `23505`, through whatever TypeORM wrapped it in.
 *
 * Keyed on the SQLSTATE and not on the message, because the message carries the
 * index name in a locale-dependent sentence and this has to keep working when
 * the index is renamed.
 */
function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; driverError?: { code?: string } };
  return candidate?.code === '23505' || candidate?.driverError?.code === '23505';
}
