import { ChainId } from '../ports/caip.types';
import { EvmRelayerPort } from './ports/evm-relayer.port';

/**
 * How long one reading of a sender's balance and fees is reused: about one
 * pass of the redemption job. Each send in that window is subtracted from the
 * reading at its worst cost, so the reading only gets more cautious until the
 * next read.
 */
export const EVM_SEND_FLOAT_CACHE_MS = 30_000;

/** DI token: the REDEEMER's {@link EvmSendFloat}, shared by redemption and held moves. */
export const EVM_REDEEMER_SEND_FLOAT = 'EVM_REDEEMER_SEND_FLOAT';

export interface EvmSendBudget {
  /** The balance read, less what this process has sent since. */
  readonly balanceWei: bigint;
  /** What is kept back: the reserve, or 0 for an urgent send. */
  readonly reserveWei: bigint;
  /** `balanceWei − reserveWei`, never below 0. */
  readonly spendableWei: bigint;
  /** The fee the node checks a send's funds against (`gasLimit × maxFeePerGas`). */
  readonly maxFeePerGas: bigint;
}

interface Reading {
  wei: bigint;
  readonly maxFeePerGas: bigint;
  readonly until: number;
}

/**
 * The float a background sender may spend, so a send is sized to it rather
 * than refused by the node.
 *
 * The node refuses a transaction whose `gasLimit × maxFeePerGas + value` is
 * more than the sender's balance (`insufficient funds`). Before 2026-10-29 the
 * redeemer found out by sending: every batch was refused, one after another.
 * Now the batch is cut to what the float can pay, and a pass that cannot pay
 * even one item ends without broadcasting anything.
 *
 * ## The reserve
 *
 * `EVM_RELAYER_FLOAT_CRITICAL_WEI`, the mark at which `EvmRelayerFloatMonitor`
 * pages and `RedeemerFloatGate` stops admitting paid calls. Ordinary sends keep
 * it back, so the float sits at the page and not at zero. An URGENT send (a
 * voucher near its deadline, a held refund near its timeout) may spend the
 * reserve. Holding ETH back while the payment it would save expires is not a
 * saving.
 *
 * Unknown is not empty: a balance or fee that cannot be read gives `null`, and
 * the caller sends as before. The relayer's own pre-send check is still there.
 */
export class EvmSendFloat {
  private readonly readings = new Map<ChainId, Reading>();

  constructor(
    private readonly sender: Pick<EvmRelayerPort, 'balanceWei' | 'feesPerGas'>,
    readonly reserveWei: bigint,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The budget for one send on `chainId`, or `null` when it cannot be read. */
  async budget(chainId: ChainId, urgent: boolean): Promise<EvmSendBudget | null> {
    const reading = await this.read(chainId);
    if (reading === null) return null;
    const reserveWei = urgent ? 0n : this.reserveWei;
    return {
      balanceWei: reading.wei,
      reserveWei,
      spendableWei: reading.wei > reserveWei ? reading.wei - reserveWei : 0n,
      maxFeePerGas: reading.maxFeePerGas,
    };
  }

  /** A send went out: its worst cost comes off the cached balance. */
  spent(chainId: ChainId, wei: bigint): void {
    const reading = this.readings.get(chainId);
    if (reading) reading.wei = reading.wei > wei ? reading.wei - wei : 0n;
  }

  /** The node said `insufficient funds`: the float is empty until the next read. */
  drained(chainId: ChainId): void {
    const reading = this.readings.get(chainId);
    if (reading) reading.wei = 0n;
  }

  private async read(chainId: ChainId): Promise<Reading | null> {
    const now = this.now();
    const cached = this.readings.get(chainId);
    if (cached && cached.until > now) return cached;
    if (typeof this.sender.feesPerGas !== 'function') return null;
    try {
      const [wei, fees] = await Promise.all([
        this.sender.balanceWei(chainId),
        this.sender.feesPerGas(chainId),
      ]);
      const reading = {
        wei,
        maxFeePerGas: fees.maxFeePerGas,
        until: now + EVM_SEND_FLOAT_CACHE_MS,
      };
      this.readings.set(chainId, reading);
      return reading;
    } catch {
      return null;
    }
  }
}

/** Whether `gasLimit` at the budget's fee fits what it may spend. */
export function fitsBudget(gasLimit: bigint, budget: EvmSendBudget): boolean {
  return gasLimit * budget.maxFeePerGas <= budget.spendableWei;
}

/**
 * `EVM_RELAYER_FLOAT_CRITICAL_WEI` as the send reserve. Lenient on purpose: the
 * scheduler parses the mark strictly (`parseFloatMarks`) and fails its boot on
 * a bad value. A process that does not hold the mark keeps no reserve.
 */
export function parseSendReserveWei(raw: string | undefined): bigint {
  return raw !== undefined && /^[0-9]+$/.test(raw) ? BigInt(raw) : 0n;
}
