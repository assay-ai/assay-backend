import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CacheHeader } from '@shared/decorators/cache-header.decorator';

import { GetChainsResponseDto } from '../dto/get-chains.dto';
import { ChainDirectoryService } from '../services/chain-directory.service';

/**
 * Which chains this deployment offers.
 *
 * Unauthenticated on purpose: the deposit chain picker, the balance cards and
 * the wallet menu all render from it, and the list is not a secret — it is the
 * same set every 402 already advertises. It carries no tenant either: four
 * static strings and a number per chain, the same for every caller.
 *
 * ## Why the browser cache directives are overridden
 *
 * The global default is
 * `max-age=10, stale-while-revalidate=3600, stale-if-error=3600`, and the two
 * stale directives undo the reason this endpoint exists. The whole argument
 * for it is that a *build-time copy* of the chain list on the client drifts from the
 * deployment and the failure is a user shown a chain the API then refuses —
 * `stale-while-revalidate=3600` reintroduces exactly that copy, one hour deep,
 * through HTTP instead of through the bundle, and `stale-if-error` paints it
 * while the API is down. An operator who disables a chain and redeploys would
 * still be handing browsers the old picker.
 *
 * `PublicReservesController` made the same override for the same reason, and
 * that one was found by watching a live page, not by a test — hence the gate in
 * `chains.controller.spec.ts`.
 *
 * So: 60s of freshness, **no** stale window, and `must-revalidate`.
 *
 * 60 rather than 0 because the list only changes when `ENABLED_CHAINS` changes,
 * which is a deploy. What the number buys is not steady-state freshness, it is
 * the width of the window after a deploy in which a browser can still paint a
 * chain the API has stopped accepting — and that window is self-healing, and a
 * user who acts inside it hits a loud, recoverable `CHAIN_UNSUPPORTED` at the
 * deposit, at the point of action. That is a different failure from the silent
 * permanent drift of a build-time copy, which is the one this endpoint exists
 * to kill.
 * `max-age=0` would buy a request per picker render against a table that
 * changes a handful of times a year. Deleting the two stale directives is the
 * part that matters; the freshness budget is the cheap part.
 *
 * `visibility` is deliberately NOT declared, so the interceptor's own rule
 * applies: an anonymous request gets `public`, and a request carrying
 * `Authorization` is downgraded to `private` with `CDN-Cache-Control: no-store`
 * (measured, and pinned by a test). That downgrade costs nothing here — one
 * small request per minute per logged-in browser — and declaring
 * `visibility: 'public'` would opt this route out of RFC 9111's automatic
 * protection for credentialed responses permanently, a permission that would
 * then have to be re-justified every time a field is added to this DTO. The
 * payload has no tenant in it today; keeping the automatic protection means it
 * does not have to keep being true for the header to be safe.
 *
 * There is deliberately no `@HttpCacheTTL`: the handler reads an in-memory list
 * and does no I/O, so a server-side Redis cache in front of it would add a
 * network round trip to a `Map` lookup.
 */
@ApiTags('Chains')
@Controller('chains')
export class ChainsController {
  constructor(private readonly chains: ChainDirectoryService) {}

  @Get()
  @CacheHeader({
    maxAge: 60,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    mustRevalidate: true,
  })
  @ApiOperation({ summary: 'The chains this deployment offers, in ENABLED_CHAINS order' })
  @ApiResponse({ status: 200, type: GetChainsResponseDto })
  list(): GetChainsResponseDto {
    return this.chains.listChains();
  }
}
