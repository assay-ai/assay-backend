import { Logger } from '@nestjs/common';

/**
 * How long an endpoint that failed is asked last. Reads and sends go to the
 * first endpoint not cooling down, so a failed one costs one request per pass
 * of this window, not one per call.
 */
export const EVM_RPC_ENDPOINT_COOLDOWN_MS = 60_000;

/**
 * A wrong chain is a configuration mistake, not an outage: asked again rarely,
 * so that fixing the provider's routing recovers it without a restart.
 */
export const EVM_RPC_WRONG_CHAIN_COOLDOWN_MS = 3_600_000;

/**
 * JSON-RPC codes a gateway answers with HTTP 200 instead of serving the call:
 * limits, auth, and a method this provider does not offer. Not one of them is
 * the node's verdict on the call, so another endpoint may still serve it.
 *
 * Never `3` or `-32000`: those are reverts and send refusals, the same answer
 * from any honest node.
 */
const GATEWAY_REFUSAL_CODES: ReadonlySet<number> = new Set([
  -32005, -32029, -32052, -32090, -32097, -32601, 401, 402, 403, 429,
]);

/** HTTP answers a gateway gives before forwarding: the bytes reached no node. */
const GATEWAY_REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 429]);

/** True when this HTTP status means the gateway refused before any node saw the request. */
export function isGatewayRefusalStatus(status: number): boolean {
  return GATEWAY_REFUSAL_STATUSES.has(status);
}

/**
 * The tag of a 2xx body that is not an answer from a node: `BAD_JSON`, or the
 * gateway's refusal code. `null` for a result, a revert or a batch.
 */
export function refusalInBody(body: string): string | null {
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    return 'BAD_JSON';
  }
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return null;
  const code = (reply as { error?: { code?: unknown } }).error?.code;
  return typeof code === 'number' && GATEWAY_REFUSAL_CODES.has(code) ? `RPC ${code}` : null;
}

/** One endpoint's state. The host only: a provider's key lives in the URL's path or query. */
export interface EvmRpcEndpointHealth {
  readonly host: string;
  /** When the current run of failures began, in ms; `null` while it answers. */
  readonly failingSince: number | null;
  /** A tag from this file (`HTTP 403`, `RPC -32005`, `NETWORK`, ...), never a provider's words. */
  readonly lastFailure: string | null;
}

interface Endpoint {
  readonly url: string;
  readonly host: string;
  failingSince: number | null;
  lastFailure: string | null;
  retryAt: number;
  chainChecked: boolean;
}

/**
 * The ordered endpoints of one chain and which of them to ask first.
 *
 * Process-local on purpose: every process finds out by asking, and one that has
 * not asked yet loses one request.
 */
export class EvmRpcEndpoints {
  private readonly logger = new Logger(EvmRpcEndpoints.name);
  private readonly endpoints: Endpoint[];

  constructor(
    urls: readonly string[],
    private readonly now: () => number = () => Date.now(),
  ) {
    if (urls.length === 0) throw new Error('an EVM RPC client needs at least one URL');
    this.endpoints = urls.map((url) => ({
      url,
      host: new URL(url).host,
      failingSince: null,
      lastFailure: null,
      retryAt: 0,
      chainChecked: false,
    }));
  }

  get size(): number {
    return this.endpoints.length;
  }

  /** The configured order, those cooling down last: every endpoint stays a last resort. */
  order(): readonly string[] {
    const now = this.now();
    const ready = this.endpoints.filter((endpoint) => endpoint.retryAt <= now);
    const cooling = this.endpoints.filter((endpoint) => endpoint.retryAt > now);
    return [...ready, ...cooling].map((endpoint) => endpoint.url);
  }

  chainChecked(url: string): boolean {
    return this.find(url).chainChecked;
  }

  markChainChecked(url: string): void {
    this.find(url).chainChecked = true;
  }

  succeeded(url: string): void {
    const endpoint = this.find(url);
    if (endpoint.failingSince !== null) {
      this.logger.log(`EVM RPC ${endpoint.host} answers again`);
    }
    endpoint.failingSince = null;
    endpoint.lastFailure = null;
    endpoint.retryAt = 0;
  }

  failed(url: string, tag: string, cooldownMs = EVM_RPC_ENDPOINT_COOLDOWN_MS): void {
    const endpoint = this.find(url);
    const now = this.now();
    if (endpoint.failingSince === null) {
      endpoint.failingSince = now;
      this.logger.warn(`EVM RPC ${endpoint.host} failed (${tag})`);
    }
    endpoint.lastFailure = tag;
    endpoint.retryAt = now + cooldownMs;
  }

  health(): readonly EvmRpcEndpointHealth[] {
    return this.endpoints.map(({ host, failingSince, lastFailure }) => ({
      host,
      failingSince,
      lastFailure,
    }));
  }

  private find(url: string): Endpoint {
    const endpoint = this.endpoints.find((candidate) => candidate.url === url);
    if (!endpoint) throw new Error("not one of this client's EVM RPC endpoints");
    return endpoint;
  }
}
