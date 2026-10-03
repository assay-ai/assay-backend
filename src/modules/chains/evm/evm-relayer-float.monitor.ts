import { Inject, Injectable, Logger } from '@nestjs/common';
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
} from './evm-relayer-float.constants';
import { EVM_RELAYER_KEYS_ENV } from './evm-relayer-key-source';
import { EVM_RELAYER, EvmRelayerPort } from './ports/evm-relayer.port';

export type FloatLevel = 'OK' | 'LOW' | 'CRITICAL' | 'UNREADABLE' | 'NO_RELAYER';

export interface FloatReading {
  readonly chainId: ChainId;
  /**
   * `null` only when the relayer has no key for this chain, which is a
   * misconfiguration in the process that sends — see {@link check}. That case
   * is its own level, `NO_RELAYER`, and never `UNREADABLE`.
   */
  readonly address: AccountId | null;
  /** `null` means UNREADABLE or NO_RELAYER, which is not "zero" and not "fine". */
  readonly wei: bigint | null;
  readonly level: FloatLevel;
  /** `floor(wei / perGrantMaxWei)`, or `null` when there is no balance to divide. */
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
 * It pays for REDEMPTIONS too. A grant that empties it stops every provider
 * getting paid, which is a worse failure than one buyer waiting — which is why
 * the grant's own check refuses rather than borrows, and why `CRITICAL` here
 * says which of the two is about to stop.
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
          `${reading.chainId}=${reading.level}` +
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
      readings.push(await this.readOne(chainId, marks));
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

  private async readOne(chainId: ChainId, marks: EvmRelayerFloatMarks): Promise<FloatReading> {
    let address: AccountId;
    try {
      address = await this.relayer.address(chainId);
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
        `no relayer account on ${chainId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.emit({
        severity: AlertSeverity.WARN,
        name: EVM_RELAYER_FLOAT_ALERTS.NO_RELAYER,
        summary:
          `This process has no relayer key for ${chainId}, so it can neither redeem vouchers ` +
          `nor fund a withdraw gas grant on it`,
        details: {
          chainId,
          // No error message, for `UNREADABLE`'s reason one branch down: a
          // configuration failure on this path names the variable it wanted,
          // and the variable is the one holding key material.
          relayer: '(no relayer account on this chain)',
          variable: EVM_RELAYER_KEYS_ENV,
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: chainId,
      });
      return { chainId, address: null, wei: null, level: 'NO_RELAYER', withdrawsRemaining: null };
    }

    let wei: bigint;
    try {
      wei = await this.relayer.balanceWei(chainId);
    } catch (error) {
      // NOT zero, and not fine. A monitor that swallows an RPC error goes quiet
      // exactly when the chain is unhealthy, and both wrong answers page
      // somebody — so the defect would never show up in the alert VOLUME, only
      // in the alert TEXT, at 3am, being about the wrong incident.
      this.logger.error(
        `the relayer float on ${chainId} could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      await this.emit({
        severity: AlertSeverity.WARN,
        name: EVM_RELAYER_FLOAT_ALERTS.UNREADABLE,
        summary: `The EVM relayer's ETH float on ${chainId} could not be read`,
        details: {
          chainId,
          relayer: address,
          // The error MESSAGE is deliberately absent: an RPC failure quotes the
          // URL it failed against, and an RPC URL on this platform can carry an
          // API key in its path, where structural redaction cannot see it. It
          // is in the log line above.
          balanceWei: '(unreadable)',
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: chainId,
      });
      return { chainId, address, wei: null, level: 'UNREADABLE', withdrawsRemaining: null };
    }

    const withdrawsRemaining = Number(wei / marks.perGrantMaxWei);
    const common = {
      chainId,
      relayer: address,
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
        summary: `The EVM relayer's ETH float on ${chainId} is at or below its critical mark`,
        details: {
          ...common,
          // In this order, because voucher redemption is the expensive one:
          // calls have been served and cannot be collected.
          stops:
            'voucher redemption stops first (calls served, uncollectable), then the withdraw ' +
            'gas grant. withdraw() and withdrawStake() are msg.sender-only and never ' +
            'pause-gated — do NOT setPaused because the float is dry.',
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: chainId,
      });
      return { chainId, address, wei, level: 'CRITICAL', withdrawsRemaining };
    }

    if (wei <= marks.lowWei) {
      await this.emit({
        severity: AlertSeverity.WARN,
        name: EVM_RELAYER_FLOAT_ALERTS.LOW,
        summary: `The EVM relayer's ETH float on ${chainId} is at or below its low mark`,
        details: common,
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: chainId,
      });
      return { chainId, address, wei, level: 'LOW', withdrawsRemaining };
    }

    return { chainId, address, wei, level: 'OK', withdrawsRemaining };
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
