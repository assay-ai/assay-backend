import { ChainId, isChainId } from './ports/caip.types';

/** DI token for the chain → public RPC URL map served by `GET /chains`. */
export const PUBLIC_RPC_URLS = 'PUBLIC_RPC_URLS';

export const PUBLIC_RPC_URLS_ENV = 'PUBLIC_RPC_URLS';

/**
 * `{"eip155:46630":"https://rpc.testnet.chain.robinhood.com"}` — the endpoints
 * this deployment is willing to hand to a browser.
 *
 * Deliberately not derived from `EVM_RPC_URLS` or `SOLANA_RPC_URL`. Those are
 * how the BACKEND reaches a chain and may be private: dev's Solana URL carries
 * a Helius api-key inline, and an EVM node may sit inside a VPC. Serving
 * either of them from a public route would publish it, so naming the public
 * ones is a separate, deliberate act.
 *
 * Malformed input is an EMPTY MAP, never a throw: every consumer treats a
 * missing entry as "this chain cannot be signed for in the browser" and says
 * so by name, which is a better failure than a process that will not boot
 * because a display value was mistyped.
 */
export function parsePublicRpcUrls(raw: string | undefined): ReadonlyMap<ChainId, string> {
  if (!raw?.trim()) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();

  const urls = new Map<ChainId, string>();
  for (const [chainId, url] of Object.entries(parsed)) {
    // `https` only, and no credentials in it: this value is served to anyone.
    if (!isChainId(chainId) || typeof url !== 'string') continue;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    const insecureLocalhost =
      parsedUrl.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(parsedUrl.hostname);
    if ((parsedUrl.protocol !== 'https:' && !insecureLocalhost) || parsedUrl.username) continue;
    urls.set(chainId, url);
  }
  return urls;
}
