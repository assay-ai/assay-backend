import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  EVM_SEND_FLOAT_CACHE_MS,
  EvmSendFloat,
  fitsBudget,
  parseSendReserveWei,
} from '@modules/chains/evm/evm-send-float';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;

function sender(wei = 1_000_000n, maxFeePerGas = 10n) {
  return {
    reads: 0,
    wei,
    async balanceWei() {
      this.reads += 1;
      return this.wei;
    },
    async feesPerGas() {
      return { maxFeePerGas, maxPriorityFeePerGas: 0n };
    },
  };
}

describe('EvmSendFloat', () => {
  it('keeps the reserve back from an ordinary send and not from an urgent one', async () => {
    const float = new EvmSendFloat(sender(1_000_000n), 400_000n);

    expect(await float.budget(CHAIN, false)).toEqual({
      balanceWei: 1_000_000n,
      reserveWei: 400_000n,
      spendableWei: 600_000n,
      maxFeePerGas: 10n,
    });
    expect((await float.budget(CHAIN, true))?.spendableWei).toBe(1_000_000n);
  });

  it('never reports a negative spendable', async () => {
    const float = new EvmSendFloat(sender(100n), 400_000n);

    expect((await float.budget(CHAIN, false))?.spendableWei).toBe(0n);
  });

  it('reads once per window, and takes each send off the cached balance', async () => {
    let now = 0;
    const port = sender(1_000_000n);
    const float = new EvmSendFloat(port, 0n, () => now);

    await float.budget(CHAIN, false);
    float.spent(CHAIN, 300_000n);
    expect((await float.budget(CHAIN, false))?.balanceWei).toBe(700_000n);
    expect(port.reads).toBe(1);

    now += EVM_SEND_FLOAT_CACHE_MS + 1;
    expect((await float.budget(CHAIN, false))?.balanceWei).toBe(1_000_000n);
    expect(port.reads).toBe(2);
  });

  it('is empty after the node said insufficient funds, until the next read', async () => {
    const float = new EvmSendFloat(sender(1_000_000n), 0n);
    await float.budget(CHAIN, false);

    float.drained(CHAIN);

    expect((await float.budget(CHAIN, true))?.spendableWei).toBe(0n);
  });

  it('is unknown (null), not empty, when the balance or fees cannot be read', async () => {
    const failing = {
      balanceWei: async () => {
        throw new Error('rpc down');
      },
      feesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
    };

    expect(await new EvmSendFloat(failing, 0n).budget(CHAIN, false)).toBeNull();
    expect(
      await new EvmSendFloat({ balanceWei: async () => 1n }, 0n).budget(CHAIN, false),
    ).toBeNull();
  });

  it('fits a limit whose gas × maxFeePerGas is at most what may be spent', () => {
    const budget = { balanceWei: 100n, reserveWei: 0n, spendableWei: 100n, maxFeePerGas: 10n };

    expect(fitsBudget(10n, budget)).toBe(true);
    expect(fitsBudget(11n, budget)).toBe(false);
  });

  it('reads the critical mark leniently as the reserve', () => {
    expect(parseSendReserveWei('500000000000000')).toBe(500_000_000_000_000n);
    expect(parseSendReserveWei(undefined)).toBe(0n);
    expect(parseSendReserveWei('0.5')).toBe(0n);
  });
});
