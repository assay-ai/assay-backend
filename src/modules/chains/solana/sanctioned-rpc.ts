import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createSolanaRpcSubscriptions,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from '@solana/kit';

import { AccountNotificationsClient } from './solana-account-watcher.service';

import { withSanctionedEgress } from '@shared/network/egress';

/**
 * `createSolanaRpc`, with its requests declared to the egress guard.
 *
 * `@solana/kit` reaches global `fetch` through its own transport
 * (`@solana/rpc-transport-http`), which is a second HTTP client that no source
 * scan can see. `installEgressLockdown` therefore blocks it, correctly
 * and unhelpfully: Solana RPC is a legitimate caller.
 *
 * The first attempt at reconciling those two facts was an exemption list in the
 * guard, matched against the stack. It was deleted, and the reasons are worth
 * keeping because they generalise:
 *
 * - **It did not work.** `@solana/kit` is a re-export barrel; the `fetch` call
 *   happens in `@solana/rpc-transport-http`, so no frame contained the string
 *   being matched. Solana RPC would have broken for the first person to enable
 *   the guard — the exact misfire that gets a control switched off for good.
 * - **It was forgeable five ways**, all proven: an object key or class method
 *   named `@solana/kit` puts that text in a frame name; a module at a path
 *   containing it does the same; any dependency named `rpc-*` was pre-exempted;
 *   and `Error.prepareStackTrace = () => '@solana/kit'` exempts *every call in
 *   the process*, permanently, from anywhere.
 *
 * A stack-text match is attacker-writable, so it cannot be a trust boundary.
 * This is the honest version: the exemption is a **lexical scope we control**
 * rather than a string anyone can produce. Only requests issued by this
 * transport are sanctioned, and only for as long as the call takes.
 *
 * `SOLANA_RPC_URL` is operator configuration and never a provider's URL, which
 * is why sanctioning it is acceptable at all. The durable fix — a transport
 * built on `EgressHttpClient`, so Solana RPC gets the same address rules as
 * everything else — is not built yet; this is the seam it will replace.
 */
export function createSanctionedSolanaRpc(url: string): Rpc<SolanaRpcApi> {
  const transport = createDefaultRpcTransport({ url });

  const sanctioned = ((...args: Parameters<RpcTransport>) =>
    withSanctionedEgress(() => transport(...args))) as RpcTransport;

  return createSolanaRpcFromTransport(sanctioned);
}

/**
 * Helius closes an idle websocket after ten minutes; `@solana/kit` answers that
 * with an autopinger, and this is the interval it pings on.
 */
const SUBSCRIPTIONS_PING_INTERVAL_MS = 60_000;

/**
 * `createSolanaRpcSubscriptions`, with its socket declared to the egress guard.
 *
 * The same reasoning as `createSanctionedSolanaRpc` above: the exemption is a
 * lexical scope around the one call that opens the subscription socket, so this
 * call site is the only place a Solana subscription is permitted to dial out.
 */
export function createSanctionedSolanaRpcSubscriptions(url: string): AccountNotificationsClient {
  const subscriptions = createSolanaRpcSubscriptions(url, {
    intervalMs: SUBSCRIPTIONS_PING_INTERVAL_MS,
  });

  return {
    accountNotifications(account, config) {
      const notifications = subscriptions.accountNotifications(account, config);

      return {
        // Only the `subscribe` is wrapped: that is where the channel — and so
        // the `WebSocket` — is constructed. Wrapping the factory above would
        // sanction nothing, because `createSolanaRpcSubscriptions` opens no
        // socket until something subscribes.
        subscribe: (options) => withSanctionedEgress(() => notifications.subscribe(options)),
      };
    },
  };
}

/**
 * The `wss://` URL for the subscriptions client, or `undefined` when there is
 * nothing to connect to.
 *
 * `SOLANA_RPC_WS_URL` wins. Otherwise the HTTP RPC URL is reused with its
 * scheme swapped, which is correct for Helius and for the public clusters and
 * is checked rather than assumed — anything that is not `http`/`https` yields
 * `undefined` and the watcher stays off rather than dialling a guess.
 */
export function solanaSubscriptionsUrl(
  explicit: string | undefined,
  rpcUrl: string | undefined,
): string | undefined {
  if (explicit) {
    return /^wss?:/i.test(explicit) ? explicit : undefined;
  }
  if (!rpcUrl) {
    return undefined;
  }

  const match = /^http(s?):/i.exec(rpcUrl);
  return match ? `ws${match[1]}:${rpcUrl.slice(match[0].length)}` : undefined;
}
