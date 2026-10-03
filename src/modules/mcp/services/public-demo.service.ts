import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ChainId } from '@modules/chains/ports/caip.types';
import { JsonObject } from '@modules/tool/domain/mapping/mapping.types';
import { ProviderRouterService } from '@modules/tool/services/provider-router.service';

import { McpErrors } from '../errors/mcp.errors';
import { MCP_SESSION_SOURCE, McpSessionPort } from '../ports/mcp-session.port';
import { McpCatalogueService } from './mcp-catalogue.service';
import { McpToolCallService } from './mcp-tool-call.service';
import { RedisDemoRateLimiter } from './redis-demo-rate-limiter.service';

export const PUBLIC_DEMO_CONFIG = Symbol('PUBLIC_DEMO_CONFIG');

export interface PublicDemoConfig {
  /** The credential the demo calls as. Resolved through `McpSessionPort`, never constructed. */
  readonly token: string;
  /** The organization that credential belongs to. The verdict route's fence. */
  readonly organizationId: string;
  readonly healthyTool: string;
  readonly brokenTool: string;
  /** Longest query a visitor may send. Free text needs a bound. */
  readonly maxQueryLength: number;
}

export type DemoSide = 'pass' | 'fail';

export interface DemoRunResult {
  /**
   * The poll key, and it is the **intent id**, not `X-X402-Call-Id`.
   *
   * The call id is the obvious candidate: it is minted once and cannot be
   * spoofed by a provider's mapping. Both are true of it — and `McpReceipt`
   * does not expose it. The intent id has the same two properties (platform
   * minted, unguessable, one per call) and is fenced by exactly the same check
   * in `PublicDemoVerdictService`, so nothing about the route's safety changes.
   */
  readonly intentId: string | null;
  readonly status: 'RESULT' | 'ERROR';
  readonly latencyMs: number;
  readonly body: unknown;
  readonly listedPrice: {
    readonly amount: string;
    readonly asset: string;
    readonly decimals: number;
  };
  /**
   * Set when the broken side could not tell its story for this query — see
   * `tooFewResultsToFail` below. The page shows it instead of a misleading pass.
   */
  readonly inconclusive: string | null;
}

/**
 * Phase one of the public demo: run a real call.
 *
 * **No money in this response.** Only the listed price and the fact that a hold
 * is open. The garbage call reports `charged` at the synchronous step and is
 * refunded only after the worker judges it, so putting a figure here would make
 * the page print "You paid $0.0100" and then correct itself to `$0.0000` in
 * front of the visitor. Money belongs to phase two.
 *
 * The session is **resolved**, never constructed — see `demo-identity.ts` for
 * why that matters more than it looks.
 */
@Injectable()
export class PublicDemoService {
  private readonly logger = new Logger(PublicDemoService.name);

  constructor(
    @Inject(MCP_SESSION_SOURCE) private readonly sessions: McpSessionPort,
    private readonly calls: McpToolCallService,
    private readonly catalogue: McpCatalogueService,
    private readonly router: ProviderRouterService,
    private readonly rateLimiter: RedisDemoRateLimiter,
    @Inject(PUBLIC_DEMO_CONFIG) private readonly config: PublicDemoConfig,
    @Inject(ENABLED_CHAINS) private readonly enabledChains: readonly ChainId[],
  ) {}

  async run(input: {
    readonly side: DemoSide;
    readonly query: string;
    readonly address: string;
  }): Promise<DemoRunResult> {
    const query = input.query.trim();
    if (!query || query.length > this.config.maxQueryLength) {
      throw McpErrors.demoQueryInvalid({
        detail: `must be 1..${this.config.maxQueryLength} characters`,
      });
    }

    const rate = await this.rateLimiter.take(input.address);
    if (!rate.allowed) {
      throw McpErrors.demoRateLimited({ reason: rate.reason });
    }

    // The demo agent's own spend policy is the other half of the guard, and it
    // is already on the path inside `call()`. Nothing is counted here.
    const session = await this.sessions.resolve(this.config.token);
    const tool = input.side === 'fail' ? this.config.brokenTool : this.config.healthyTool;

    const listedPrice = await this.listedPriceOf(tool);

    const startedAt = Date.now();
    const outcome = await this.calls.call(session, tool, { query, limit: 5 } as JsonObject);
    const latencyMs = Date.now() - startedAt;

    const body = outcome.kind === 'RESULT' ? outcome.output : { error: outcome.code };

    return {
      intentId: outcome.kind === 'RESULT' ? outcome.receipt.intentId : outcome.intentId,
      status: outcome.kind === 'RESULT' ? 'RESULT' : 'ERROR',
      latencyMs,
      body,
      listedPrice,
      inconclusive: input.side === 'fail' ? this.tooFewResultsToFail(body) : null,
    };
  }

  /**
   * The tool's listed price, read from the same quote the router prices a real
   * call with. Phase one knows this and that a hold is open — nothing else
   * about money.
   */
  private async listedPriceOf(
    toolName: string,
  ): Promise<{ amount: string; asset: string; decimals: number }> {
    const tool = await this.catalogue.findByName(toolName);
    // No session, and therefore no buyer to narrow to: the demo quotes what
    // ANYONE could pay, on every chain this deployment offers. `defaultChainId`
    // is `null` for the same reason — there is nobody whose default it would
    // be, and inventing one would put a chain preference on a page that has no
    // buyer.
    const quote = tool
      ? await this.router.quote(tool.id, {
          payerChains: this.enabledChains,
          defaultChainId: null,
          enabledChains: this.enabledChains,
          // A catalogue is not an offer to be paid. A tool
          // must be SHOWN rather than hidden when the reader cannot pay for it,
          // and a standing withdrawal is the buyer's cash management — hiding a
          // tool for it would make the listing flicker as they move money in and
          // out. The refusal, when it comes, comes from the CALL path.
          withdrawingChains: [],
        })
      : null;
    const price = quote?.price;

    return price
      ? { amount: price.amount, asset: price.asset, decimals: price.decimals }
      : { amount: '0', asset: '', decimals: 0 };
  }

  /**
   * The broken binding fails only when the upstream returns **two or more**
   * rows, and the visitor types the query.
   *
   * Measured 2026-09-03: `"cargo ship"` returns 5 rows and the call fails as
   * intended; `"zzqxjvwk"` returns 0 and the call takes the empty-result path,
   * which on this platform is **chargeable**. A query matching exactly one
   * article is worse still — `ids_distinct` drops out of the denominator, the
   * score becomes 1.0, and the call PASSES and is charged.
   *
   * So the broken binding does not fail *whatever you ask*, and the page must
   * not present either outcome as the demo working.
   * Saying "try a broader query" is honest; showing a pass is not.
   */
  private tooFewResultsToFail(body: unknown): string | null {
    const results = (body as { results?: unknown } | null)?.results;
    if (!Array.isArray(results) || results.length >= 2) {
      return null;
    }

    return (
      'That query matched fewer than two articles, so the duplicate-id check had ' +
      'nothing to compare and this call could not demonstrate a refusal. Try a broader query.'
    );
  }
}
