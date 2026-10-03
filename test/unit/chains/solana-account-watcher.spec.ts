import { toAccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { SolanaAccountWatcher } from '@modules/chains/solana/solana-account-watcher.service';

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const ACCOUNT = toAccountId(DEVNET, 'AtW955vMKUkYMef861U1ZhPQsqbj2D4Xyb5HnFcm3S6E');

/** A stream a test drives: push a notification, or make the next `next()` throw. */
function controllableStream() {
  let pushNext: ((value: IteratorResult<unknown>) => void) | null = null;
  let failNext: ((error: unknown) => void) | null = null;

  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise<IteratorResult<unknown>>((resolve, reject) => {
            pushNext = resolve;
            failNext = reject;
          });
        },
      };
    },
  };

  return {
    iterable,
    async notify() {
      pushNext?.({ value: {}, done: false });
      await Promise.resolve();
      await Promise.resolve();
    },
    async drop(error = new Error('socket closed')) {
      failNext?.(error);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function buildHarness() {
  const streams = [controllableStream(), controllableStream(), controllableStream()];
  let opened = 0;

  const client = {
    accountNotifications: jest.fn(() => ({
      subscribe: jest.fn(async () => {
        const stream = streams[Math.min(opened, streams.length - 1)];
        opened += 1;
        return stream.iterable;
      }),
    })),
  };

  const watcher = new SolanaAccountWatcher(client as never, { backoffMs: () => 0 });

  return {
    watcher,
    client,
    streams,
    get opened() {
      return opened;
    },
  };
}

describe('SolanaAccountWatcher', () => {
  it('calls onChange for every notification, carrying no payload with it', async () => {
    const { watcher, streams } = buildHarness();
    const onChange = jest.fn();

    const stop = await watcher.watch(ACCOUNT, onChange);
    await streams[0].notify();
    await streams[0].notify();

    expect(onChange).toHaveBeenCalledTimes(2);
    // The port promises a wake-up, not data. A handler that received the
    // notification body could come to depend on it.
    expect(onChange).toHaveBeenCalledWith();
    stop();
  });

  it('subscribes at finalized commitment, the same bar the sweep re-reads at', async () => {
    const { watcher, client } = buildHarness();

    const stop = await watcher.watch(ACCOUNT, jest.fn());

    expect(client.accountNotifications).toHaveBeenCalledWith(
      'AtW955vMKUkYMef861U1ZhPQsqbj2D4Xyb5HnFcm3S6E',
      { commitment: 'finalized' },
    );
    stop();
  });

  it('reconnects after the socket drops and keeps delivering', async () => {
    const { watcher, streams } = buildHarness();
    const onChange = jest.fn();

    const stop = await watcher.watch(ACCOUNT, onChange);
    await streams[0].notify();
    expect(onChange).toHaveBeenCalledTimes(1);

    // Helius closes an idle socket after ten minutes; a dropped connection is
    // an ordinary event on this path, not a fault to be escalated.
    await streams[0].drop();
    await streams[1].notify();

    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stops reconnecting once the watch is stopped', async () => {
    const { watcher, streams } = buildHarness();
    const onChange = jest.fn();

    const stop = await watcher.watch(ACCOUNT, onChange);
    stop();
    await streams[0].drop();

    // A watcher that kept dialling after shutdown would hold the scheduler
    // process open and reconnect forever against a cluster nobody is reading.
    await streams[1].notify();
    expect(onChange).not.toHaveBeenCalled();
  });
});
