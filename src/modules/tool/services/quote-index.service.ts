import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { RoutingCandidate, RoutingContext } from '../domain/routing';
import { TOOL_CATALOGUE, ToolCataloguePort } from '../ports/tool-catalogue.port';
import { Tool } from '../ports/tool.types';
import { ProviderRouterService, ToolQuote } from './provider-router.service';

/** A listing's price is at most this old (design spec §7.4, "Quote index"). */
export const QUOTE_INDEX_MAX_AGE_MS = 60_000;

/** Bumped on every binding write, by any process; a changed value drops the index. */
export const QUOTE_INDEX_EPOCH_KEY = 'assay:quote-index:epoch';

/** Injected for tests; production reads the wall clock. */
export const QUOTE_INDEX_CLOCK = 'QUOTE_INDEX_CLOCK';

interface IndexEntry {
  readonly tool: Tool;
  readonly candidates: readonly RoutingCandidate[];
  readonly loadedAt: number;
  readonly epoch: string | null;
}

/**
 * The quote index: what `tools/list` and the Connect preview price from.
 *
 * Per tool it holds the routing candidates — each binding with its provider's
 * state, tier, stake per chain, grace and ceilings — exactly as
 * `ProviderRouterService.gatherCandidates` loads them for a call. Pricing a
 * listing under a viewer's own rules is then the router's pure half
 * (`quoteFromCandidates`): no `router.quote()`, no registry read and no chain
 * read per tool per list (NFR-2).
 *
 * Kept fresh two ways:
 *
 * - **Age.** An entry older than {@link QUOTE_INDEX_MAX_AGE_MS} is reloaded
 *   before it is used, so stake and tier changes (which arrive from the chain
 *   and the stats pipeline, not from a write here) show within a minute.
 * - **Binding writes.** `ToolBindingChangeSubscriber` bumps a Redis epoch on
 *   every `tool_bindings` insert, update or delete, in whichever process made
 *   it; a listing that sees a new epoch reloads everything it reads.
 *
 * A call never reads this. `tools/call` gathers its own candidates, so a stale
 * listing can show an old price but can never route, charge or admit
 * anything.
 */
@Injectable()
export class QuoteIndexService {
  private readonly logger = new Logger(QuoteIndexService.name);
  private readonly entries = new Map<string, IndexEntry>();
  private readonly loading = new Map<string, Promise<IndexEntry | null>>();

  constructor(
    private readonly router: ProviderRouterService,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    @Optional() private readonly cache?: CacheService,
    @Optional() @Inject(QUOTE_INDEX_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  /**
   * One quote per tool, each under its own context (the viewer's chain and
   * rules). A tool whose snapshot cannot be loaded is `null`, alone — the
   * others are still priced.
   */
  async quoteMany(
    toolIds: readonly string[],
    contextFor: (toolId: string) => RoutingContext,
  ): Promise<Map<string, ToolQuote | null>> {
    const epoch = await this.readEpoch();
    const entries = await Promise.all(toolIds.map((toolId) => this.entry(toolId, epoch)));

    const quotes = new Map<string, ToolQuote | null>();
    toolIds.forEach((toolId, index) => {
      const entry = entries[index];
      if (!entry) {
        quotes.set(toolId, null);
        return;
      }
      try {
        quotes.set(
          toolId,
          this.router.quoteFromCandidates(entry.tool, entry.candidates, contextFor(toolId)),
        );
      } catch (error) {
        // A catalogue defect in one tool (two assets on one chain) is that
        // tool's alone, as it always was for `tools/list`.
        this.logger.warn(`${toolId}: not priced — ${describe(error)}`);
        quotes.set(toolId, null);
      }
    });
    return quotes;
  }

  async quote(toolId: string, context: RoutingContext): Promise<ToolQuote | null> {
    return (await this.quoteMany([toolId], () => context)).get(toolId) ?? null;
  }

  /** Drop everything; the next read reloads. */
  invalidate(): void {
    this.entries.clear();
  }

  /** Tell every process's index that a binding changed. Best effort. */
  async bumpEpoch(): Promise<void> {
    try {
      await this.cache?.getRedisClient().incr(QUOTE_INDEX_EPOCH_KEY);
    } catch (error) {
      this.logger.warn(`quote index epoch not bumped — ${describe(error)}`);
    }
    this.invalidate();
  }

  private async entry(toolId: string, epoch: string | null): Promise<IndexEntry | null> {
    const cached = this.entries.get(toolId);
    if (cached && cached.epoch === epoch && this.now() - cached.loadedAt < QUOTE_INDEX_MAX_AGE_MS) {
      return cached;
    }

    // One load per tool at a time: a burst of listings after a refresh shares
    // one round of registry and chain reads.
    const inFlight = this.loading.get(toolId);
    if (inFlight) return inFlight;

    const load = this.load(toolId, epoch).finally(() => this.loading.delete(toolId));
    this.loading.set(toolId, load);
    return load;
  }

  private async load(toolId: string, epoch: string | null): Promise<IndexEntry | null> {
    try {
      const tool = await this.catalogue.findTool(toolId);
      if (!tool) {
        this.entries.delete(toolId);
        return null;
      }
      const entry: IndexEntry = {
        tool,
        candidates: await this.router.snapshotCandidates(toolId),
        loadedAt: this.now(),
        epoch,
      };
      this.entries.set(toolId, entry);
      return entry;
    } catch (error) {
      this.logger.warn(`${toolId}: quote index not refreshed — ${describe(error)}`);
      return null;
    }
  }

  private async readEpoch(): Promise<string | null> {
    if (!this.cache) return null;
    try {
      return await this.cache.getRaw(QUOTE_INDEX_EPOCH_KEY);
    } catch {
      // Redis down: the age bound alone keeps the index fresh.
      return null;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
