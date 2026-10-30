import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { ENABLED_CHAINS } from '../enabled-chains';
import { ChainErrors } from '../errors/chains.errors';
import { AccountId, ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import {
  EVM_RELAYER_FLOAT_ALERTS,
  EVM_RELAYER_FLOAT_CRITICAL_WEI,
  EVM_RELAYER_FLOAT_CRON,
  EVM_RELAYER_FLOAT_LOW_WEI,
  EVM_RELAYER_FLOAT_MARKS,
  EvmRelayerFloatMarks,
  EvmSendingKey,
  floatDedupeKey,
} from './evm-relayer-float.constants';
import { EvmChainClockMonitor } from './evm-chain-clock.monitor';
import { RedeemerFloatGate } from './evm-redeemer-float.gate';
import { EVM_REDEEMER_KEYS_ENV, EVM_RELAYER_KEYS_ENV } from './evm-relayer-key-source';
import { EVM_REDEEMER, EVM_RELAYER, EvmRelayerPort } from './ports/evm-relayer.port';

export type FloatLevel = 'OK' | 'LOW' | 'CRITICAL' | 'UNREADABLE' | 'NO_RELAYER';

export interface FloatReading {
  readonly chainId: ChainId;
  /** Whose float: the relayer's, or the redeemer's. */
  readonly key: EvmSendingKey;
  /**
   * `null` only when the relayer has no key for this chain, which is a
   * misconfiguration in the process that sends — see {@link check}. That case
   * is its own level, `NO_RELAYER`, and never `UNREADABLE`.
   */
  readonly address: AccountId | null;
  /** `null` means UNREADABLE or NO_RELAYER, which is not "zero" and not "fine". */
  readonly wei: bigint | null;
  readonly level: FloatLevel;
  /**
   * `floor(wei / perGrantMaxWei)`, or `null` when there is no balance to divide.
   * Always `null` for the redeemer, which funds no grant.
   */
  readonly withdrawsRemaining: number | null;
}

export interface FloatCheckOptions {
  readonly enabled?: readonly ChainId[];
}

/**
 * The operational half of the EVM withdraw gas grant.
 *
 * The grant itself is bounded once-ever by `uniq_evm_gas_grants_account`, two
 * caps with no defaults, a matured-withdrawal precondition, an alert on every
 * grant, and a `sendValue` door whose type has no calldata field. This monitor
 * watches the account it spends from.
 *
 * ## `withdrawsRemaining` is the number an operator can act on, and `balanceWei` is not
 *
 * "0.004 ETH" tells nobody anything. A count of how many buyers can still be
 * helped out is the decision the person reading the alert has to make. Both go
 * in `details`, because the raw figure is what a second person re-derives from.
 *
 * The count is floored against `EVM_RELAYER_GAS_GRANT_MAX_WEI` — the per-grant
 * ceiling above which `EvmGasGrantService` refuses — rather than against a live
 * `estimateGas(withdraw) × maxFeePerGas`. Two reasons, and they point the same
 * way. `eth_estimateGas` of `withdraw()` needs a buyer address with a matured
 * request, and this monitor has none: an estimate from an arbitrary address
 * reverts, and the number that came back would be about a transaction nobody is
 * going to send. And the cap is a *bound* where an estimate is an average —
 * no grant may ever cost more than the cap, so `floor(balance / cap)` can
 * under-report and can never over-report. Erring toward "top up sooner" is the
 * safe direction for a figure whose whole job is to trigger a top-up.
 *
 * ## Why ONE mark, shared with the grant
 *
 * `GasGrantRefusal.RELAYER_FLOAT_LOW` compares against a low-water mark, and
 * this monitor alerts on one. If those are two config keys they WILL drift, and
 * the failure is silent in the worst direction: the grant keeps paying out below
 * a mark nobody is watching, or the monitor pages about a level the grant is
 * happily spending through. Both read `EVM_RELAYER_FLOAT_LOW_WEI` — the same
 * symbol, from the same module — and `evm-relayer-float.spec.ts` asserts it.
 *
 * ## Why the float matters beyond one buyer
 *
 * It pays for relayed buyer requests and slash sends too, so a grant that
 * empties it stops more than one buyer's withdrawal — which is why the grant's
 * own check refuses rather than borrows, and why `CRITICAL` here says what is
 * about to stop. Redemptions are paid by the REDEEMER's float, a separate key
 * (see "Two keys" below).
 *
 * ## Every pass says what it read, including the quiet ones
 *
 * A healthy float alerts about nothing, and without a heartbeat that would mean
 * this cron produced nothing at all — see {@link logPass}. The heartbeat is
 * what makes "no alert fired" mean the float is fine rather than mean nothing.
 * A process with no relayer key for an enabled chain is its own level and its
 * own alert, `NO_RELAYER`, and not `UNREADABLE` — see {@link readOne}.
 *
 * ## Never a sum
 *
 * One reading per enabled eip155 chain, in the order they are enabled, each with
 * its own alert and its own dedupe key. Two chains' floats are two independent
 * budgets held by two different keys; a total would report a healthy figure
 * while one chain's relayer was empty.
 *
 * ## Two keys
 *
 * The redeemer (`EVM_REDEEMER_KEYS`) pays the gas of every redemption and is a
 * different key from the relayer, so it has a float of its own. When wired, it
 * is read after the relayer on each chain, against the same marks, with the
 * same alert names and `details.key: 'redeemer'`, and its own dedupe key
 * (`floatDedupeKey`), so one key running dry never silences the other's page.
 *
 * ## The redeemer's reading closes paid-call admission
 *
 * A page alone did not stop the 2026-10-29 incident: the redeemer sat dry for
 * ten hours while the API admitted calls whose vouchers then lapsed into buyer
 * debt. So each redeemer reading is also handed to {@link RedeemerFloatGate},
 * which the api and mcp processes read before admitting a voucher — CRITICAL
 * pauses new paid calls on that chain, OK or LOW resumes them. The relayer's
 * reading is handed over the same way and closes RELAYED requests while it is
 * critical, so the float left is kept for slash sends.
 */
@Injectable()
export class EvmRelayerFloatMonitor {
  private readonly logger = new Logger(EvmRelayerFloatMonitor.name);

  constructor(
    @Inject(EVM_RELAYER) private readonly relayer: EvmRelayerPort,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    /**
     * `null` exactly when no eip155 chain is enabled — the same shape, and the
     * same reason, as `EVM_GAS_GRANT_CAPS`. Demanding an EVM variable from a
     * Solana-only deployment makes an operator set it to whatever silences the
     * boot, which is how a mark stops meaning anything.
     */
    @Inject(EVM_RELAYER_FLOAT_MARKS) private readonly marks: EvmRelayerFloatMarks | null,
    /** Optional so a test (or a process without the redeemer wired) reads the relayer alone. */
    @Optional() @Inject(EVM_REDEEMER) private readonly redeemer: EvmRelayerPort | null = null,
    /** Optional for the same reason: a test of the readings alone need not build one. */
    @Optional() private readonly gate: RedeemerFloatGate | null = null,
    /**
     * The chain clock check (review 2026-10-23 L-4), run on this pass rather
     * than on a cron of its own. Optional: a test of the floats need not build it.
     */
    @Optional() private readonly clock: EvmChainClockMonitor | null = null,
  ) {}

  /**
   * The cron door. Registered in `EvmSchedulerModule` and nowhere else — the
   * scheduler is a single instance by design (`docs/architecture.md` §Scaling
   * Design), and a `@Cron` anywhere the API imports fires once per replica.
   *
   * It cannot throw: {@link check} turns every read failure into a reading, and
   * the catch here is for the alert sink, whose being down must not stop the
   * next chain being read.
   */
  @Cron(EVM_RELAYER_FLOAT_CRON)
  async handleFloatCheck(): Promise<void> {
    try {
      this.logPass(await this.check());
    } catch (error) {
      this.logger.error(
        `the relayer float check threw past its own error handling: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // After the floats, and whatever they did: the clock check never throws,
    // and the catch is only for a fault in it this class did not foresee.
    try {
      await this.clock?.check();
    } catch (error) {
      this.logger.error(
        `the chain clock check threw past its own error handling: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * One line per pass, **including the passes that alert about nothing**.
   *
   * A healthy float emits no alert, which is correct, and left this class with
   * no output at all on its most common path: measured on a live scheduler, a
   * pass reading 1 ETH against a 0.01 ETH mark logged nothing, and the log of a
   * working monitor was byte-identical to the log of a scheduler whose cron had
   * never been registered, whose process had died, or whose `check` threw
   * before the first read (which {@link handleFloatCheck} deliberately
   * swallows). "No alert fired" is then not evidence that the float is healthy
   * — it is evidence of nothing, which is the state this monitor exists to
   * remove.
   *
   * So the heartbeat is at `log`, not `debug`: a level nobody turns on is a
   * heartbeat nobody has. It carries the reading rather than a bare "ran", so
   * the line an operator finds answers the next question too, and it names
   * every chain, because the readings are per chain and never summed.
   */
  private logPass(readings: readonly FloatReading[]): void {
    if (readings.length === 0) {
      this.logger.log('relayer float pass: no eip155 chain is enabled, so nothing was read');
      return;
    }
    const summary = readings
      .map(
        (reading) =>
          `${reading.chainId}${reading.key === 'redeemer' ? '[redeemer]' : ''}=${reading.level}` +
          `(${reading.wei === null ? 'no balance' : `${reading.wei} wei`}, ` +
          `${reading.withdrawsRemaining ?? '?'} withdraws left)`,
      )
      .join(' ');
    this.logger.log(`relayer float pass: ${summary}`);
  }

  async check(options: FloatCheckOptions = {}): Promise<readonly FloatReading[]> {
    const chains = (options.enabled ?? this.enabled).filter(
      (chainId) => namespaceOf(chainId) === ChainNamespace.EIP155,
    );

    if (chains.length === 0) return [];
    const marks = this.requireMarks();

    const readings: FloatReading[] = [];
    // Sequential on purpose: `Promise.all` would make the call order the
    // scheduler's rather than the enabled list's, and the test that proves this
    // never sums the chains reads that order.
    for (const chainId of chains) {
      const relayerReading = await this.readOne(this.relayer, 'relayer', chainId, marks);
      readings.push(relayerReading);
      // CRITICAL closes relayed requests on that chain (the 503 "try again
      // shortly"), keeping what is left for slash sends.
      await this.gate?.publish(chainId, relayerReading.level, 'relayer');
      if (this.redeemer) {
        const reading = await this.readOne(this.redeemer, 'redeemer', chainId, marks);
        readings.push(reading);
        // After the float alert, so the page that says why comes first.
        await this.gate?.publish(chainId, reading.level);
      }
    }
    return readings;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * The marks, or a refusal naming the variables.
   *
   * Unreachable in practice: the provider keys on the same enabled-chains list
   * {@link check} filters by, so a chain reaching here has marks. Kept because
   * "cannot happen" is a claim about today's wiring, and an unguarded `null`
   * here is a float floor of zero — a monitor that never alerts.
   */
  private requireMarks(): EvmRelayerFloatMarks {
    if (!this.marks) {
      throw ChainErrors.programNotConfigured({
        what: 'the EVM relayer float marks',
        variable: `${EVM_RELAYER_FLOAT_LOW_WEI} and ${EVM_RELAYER_FLOAT_CRITICAL_WEI}`,
      });
    }
    return this.marks;
  }

  private async readOne(
    port: EvmRelayerPort,
    key: EvmSendingKey,
    chainId: ChainId,
    marks: EvmRelayerFloatMarks,
  ): Promise<FloatReading> {
    const dedupeKey = floatDedupeKey(chainId, key);
    let address: AccountId;
    try {
      address = await port.address(chainId);
    } catch (error) {
      // No key for this chain. In the API that is a supported read-only
      // deployment; in the SCHEDULER — the only process that registers this
      // monitor — it means the process that sends redemptions and grants cannot
      // send. One WARN per incident window says so without becoming noise.
      //
      // **It is not `UNREADABLE`, and it used to be.** `balanceWei` needs the
      // same account this call just failed to produce, so asking for it next
      // could only fail too — and it failed into the branch below, which pages
      // *"the float could not be read"*. That is the wrong incident: it sends
      // the person paged to the RPC node, when the answer is a variable in the
      // deployment. Observed on a live keyless scheduler before this branch
      // existed. So the read is skipped, because there is nothing to read, and
      // the alert says which of the two it is.
      this.logger.error(
        `no ${key} account on ${chainId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.emit({
        severity: AlertSeverity.WARN,
        name: EVM_RELAYER_FLOAT_ALERTS.NO_RELAYER,
        summary:
          key === 'relayer'
            ? `This process has no relayer key for ${chainId}, so it can neither relay buyer ` +
              `requests nor fund a withdraw gas grant on it`
            : `This process has no redeemer key for ${chainId}, so it cannot redeem vouchers on it`,
        details: {
          chainId,
          key,
          // No error message, for `UNREADABLE`'s reason one branch down: a
          // configuration failure on this path names the variable it wanted,
          // and the variable is the one holding key material.
          [key]: `(no ${key} account on this chain)`,
          variable: key === 'relayer' ? EVM_RELAYER_KEYS_ENV : EVM_REDEEMER_KEYS_ENV,
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey,
      });
      return {
        chainId,
        key,
        address: null,
        wei: null,
        level: 'NO_RELAYER',
        withdrawsRemaining: null,
      };
    }

    let wei: bigint;
    try {
      wei = await port.balanceWei(chainId);
    } catch (error) {
      // NOT zero, and not fine. A monitor that swallows an RPC error goes quiet
      // exactly when the chain is unhealthy, and both wrong answers page
      // somebody — so the defect would never show up in the alert VOLUME, only
      // in the alert TEXT, at 3am, being about the wrong incident.
      this.logger.error(
        `the ${key} float on ${chainId} could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      await this.emit({
        severity: AlertSeverity.WARN,
        name: EVM_RELAYER_FLOAT_ALERTS.UNREADABLE,
        summary: `The EVM ${key}'s ETH float on ${chainId} could not be read`,
        details: {
          chainId,
          key,
          [key]: address,
          // The error MESSAGE is deliberately absent: an RPC failure quotes the
          // URL it failed against, and an RPC URL on this platform can carry an
          // API key in its path, where structural redaction cannot see it. It
          // is in the log line above.
          balanceWei: '(unreadable)',
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey,
      });
      return { chainId, key, address, wei: null, level: 'UNREADABLE', withdrawsRemaining: null };
    }

    // The redeemer funds no grant, so a grant count is meaningless for it.
    const withdrawsRemaining = key === 'relayer' ? Number(wei / marks.perGrantMaxWei) : null;
    const common = {
      chainId,
      key,
      [key]: address,
      balanceWei: wei.toString(),
      lowMarkWei: marks.lowWei.toString(),
      criticalMarkWei: marks.criticalWei.toString(),
      perGrantMaxWei: marks.perGrantMaxWei.toString(),
      withdrawsRemaining,
    };

    // `<=`, not `<`, on both marks. A float sitting exactly on its floor is at
    // the floor, and the next grant takes it below.
    if (wei <= marks.criticalWei) {
      await this.emit({
        severity: AlertSeverity.CRITICAL,
        name: EVM_RELAYER_FLOAT_ALERTS.CRITICAL,
        summary: `The EVM ${key}'s ETH float on ${chainId} is at or below its critical mark`,
        details: {
          ...common,
          // In this order, because voucher redemption is the expensive one:
          // calls have been served and cannot be collected.
          stops:
            key === 'relayer'
              ? 'relayed buyer requests and slash sends stop, then the withdraw gas grant. ' +
                'withdraw() and withdrawStake() are msg.sender-only and never pause-gated — ' +
                'do NOT setPaused because the float is dry.'
              : 'voucher redemption stops (calls served, uncollectable). withdraw() and ' +
                'withdrawStake() are msg.sender-only and never pause-gated — do NOT setPaused ' +
                'because the float is dry.',
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey,
      });
      return { chainId, key, address, wei, level: 'CRITICAL', withdrawsRemaining };
    }

    if (wei <= marks.lowWei) {
      await this.emit({
        severity: AlertSeverity.WARN,
        name: EVM_RELAYER_FLOAT_ALERTS.LOW,
        summary: `The EVM ${key}'s ETH float on ${chainId} is at or below its low mark`,
        details: common,
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey,
      });
      return { chainId, key, address, wei, level: 'LOW', withdrawsRemaining };
    }

    return { chainId, key, address, wei, level: 'OK', withdrawsRemaining };
  }

  /**
   * The sink being down must not stop the next chain being read.
   *
   * Same reasoning as `EvmGasGrantService`'s: losing the reading because the
   * alerting channel is unavailable would be worse than a missed page, and the
   * reading is what the next pass compares against.
   */
  private async emit(alert: Parameters<AlertPort['emit']>[0]): Promise<void> {
    try {
      await this.alerts.emit(alert);
    } catch (error) {
      this.logger.error(
        `the relayer float alert ${alert.name} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
