import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { address, Address } from '@solana/kit';

import { AccountWatchPort, StopWatching } from '../ports/account-watch.port';
import { AccountId, parseAccountId } from '../ports/caip.types';
import { SOLANA_RPC_SUBSCRIPTIONS } from './solana.constants';

/**
 * The slice of `RpcSubscriptions<SolanaRpcSubscriptionsApi>` this class uses.
 *
 * Declared structurally, like every other RPC client under `chains/solana/`,
 * so a test can drive the stream without a websocket and so the class states
 * exactly which of the API's several dozen methods it depends on.
 */
export interface AccountNotificationsClient {
  accountNotifications(
    account: Address,
    config: { commitment: 'finalized' },
  ): {
    subscribe(options: { abortSignal: AbortSignal }): Promise<AsyncIterable<unknown>>;
  };
}

export interface AccountWatcherOptions {
  /** Delay before the nth consecutive reconnect attempt. Injected so tests do not wait. */
  backoffMs?(attempt: number): number;
}

/** 1s, 2s, 4s … capped at 30s. */
function defaultBackoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

/**
 * `AccountWatchPort` over a Solana websocket subscription.
 *
 * ## Reconnection is not an error path here
 *
 * Helius closes a socket after ten minutes of inactivity, so a drop is the
 * *expected* steady state of a quiet account, not a fault. This class
 * reconnects with backoff and logs at debug; it never raises to the caller and
 * never gives up, because the caller has no better answer than "try again" and
 * the periodic sweep this port accelerates keeps running throughout.
 *
 * Keepalive itself is `@solana/kit`'s: `createSolanaRpcSubscriptions` takes an
 * `intervalMs` and pings on it, which is wired where the client is provided
 * rather than here.
 *
 * ## Why every restart re-subscribes from scratch
 *
 * There is no cursor and nothing is replayed. A notification missed while the
 * socket was down is simply missed — and that costs nothing, because the port
 * carries no data: whatever happened is still in the database, and the sweep
 * that runs on the cron will find it. Trying to recover missed notifications
 * would be building a delivery guarantee this port explicitly does not make.
 */
@Injectable()
export class SolanaAccountWatcher implements AccountWatchPort {
  private readonly logger = new Logger(SolanaAccountWatcher.name);
  private readonly backoffMs: (attempt: number) => number;

  constructor(
    @Inject(SOLANA_RPC_SUBSCRIPTIONS) private readonly client: AccountNotificationsClient,
    @Optional() options: AccountWatcherOptions = {},
  ) {
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
  }

  async watch(account: AccountId, onChange: () => void): Promise<StopWatching> {
    const { address: solanaAddress } = parseAccountId(account);
    const controller = new AbortController();

    // Resolves when the first subscription is open, so a caller can log "the
    // watcher is up" and mean it. Later reconnects do not touch this promise.
    let markOpen!: () => void;
    const opened = new Promise<void>((resolve) => {
      markOpen = resolve;
    });

    void this.run(address(solanaAddress), onChange, controller.signal, markOpen);

    await opened;

    return () => controller.abort();
  }

  private async run(
    account: Address,
    onChange: () => void,
    signal: AbortSignal,
    markOpen: () => void,
  ): Promise<void> {
    let attempt = 0;

    while (!signal.aborted) {
      try {
        const notifications = await this.client
          .accountNotifications(account, { commitment: 'finalized' })
          .subscribe({ abortSignal: signal });

        attempt = 0;
        markOpen();

        // The notification body is read and dropped on purpose — see
        // `AccountWatchPort` for why this port carries no payload.
        for await (const notification of notifications) {
          void notification;
          if (signal.aborted) {
            return;
          }
          onChange();
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        attempt += 1;
        this.logger.debug(
          `account watch on ${account} dropped (${describe(error)}); reconnecting, attempt ${attempt}`,
        );
      }

      if (signal.aborted) {
        return;
      }

      // Reached both by a thrown stream and by one that ended cleanly.
      // `markOpen` has already resolved by now in the common case; calling it
      // again is a no-op, and calling it here is what stops `watch()` hanging
      // forever if the very first subscribe never succeeds and the caller is
      // shut down.
      await this.pause(this.backoffMs(attempt), signal);
    }
  }

  private pause(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });

      function finish(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
