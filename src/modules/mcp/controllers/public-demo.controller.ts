import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { CacheHeader, NoCacheHeader } from '@shared/decorators/cache-header.decorator';
import { SingleFlight } from '@shared/decorators/single-flight.decorator';

import { DemoVerdictResponseDto, RunDemoBodyDto, RunDemoResponseDto } from '../dto/public-demo.dto';
import { PublicCompensationService } from '@modules/settlement/services/public-compensation.service';

import { PublicDemoVerdictService } from '../services/public-demo-verdict.service';
import { PublicDemoService } from '../services/public-demo.service';

/**
 * The live demo, callable by anybody.
 *
 * ## Why there is no guard
 *
 * The third unguarded controller, after `HealthcheckController` and the
 * proof-of-reserves `PublicReservesController`, and it is the least like the other two: those
 * only *read*, while this one **spends money on a stranger's request**. So the
 * absence of a guard is paid for by two limits rather than by the payload being
 * harmless:
 *
 * - a per-IP window (`RedisDemoRateLimiter`) protecting the provider's upstream;
 * - the demo agent's own spend policy, already on the call path, protecting the
 *   platform's wallet.
 *
 * Neither substitutes for the other, and the demo has no third mechanism.
 *
 * ## And the verdict route is fenced, not open
 *
 * `GET /verdict/:intentId` takes an id from the URL with no session behind it.
 * `PublicDemoVerdictService` refuses every intent outside the demo
 * organization and answers 404 rather than 403, so a foreign id is
 * indistinguishable from one that never existed. That check — not this
 * controller — is what keeps the route from publishing anybody's verification
 * stages to anybody who guesses an id.
 *
 * ## Caching
 *
 * `POST /run` is never cached: it spends money.
 *
 * `GET /verdict/:intentId` is **polled**, so it must not inherit the global
 * `stale-while-revalidate=3600`, which would let a browser keep painting
 * `PENDING` long after the verdict landed. The proof-of-reserves page hit
 * exactly that and this is
 * the same fix, harder: a poll wants no browser cache at all.
 */
@ApiTags('Public')
@Controller('public/demo')
export class PublicDemoController {
  constructor(
    private readonly demo: PublicDemoService,
    private readonly verdicts: PublicDemoVerdictService,
    private readonly compensation: PublicCompensationService,
  ) {}

  @Get('compensation')
  @CacheHeader({ maxAge: 300, staleWhileRevalidate: 0, staleIfError: 0 })
  @ApiOperation({
    summary: 'One real, already-executed slash, with its on-chain signature',
    description:
      'Not about the call you just ran — a slash needs a violated SLA window, ' +
      'a signed attestation and a 72-hour timelock. Returns null when no ' +
      'proposal is pinned, and the page then renders no strip at all rather ' +
      'than an empty one.',
  })
  @ApiResponse({ status: 200 })
  async compensationStrip(): Promise<unknown> {
    return this.compensation.read();
  }

  @Post('run')
  @NoCacheHeader()
  // Coalesces a double-click on one Run button.
  //
  // **The key MUST include the body.** `SingleFlightInterceptor`'s default key
  // is pathname + `x-user-id` + query string and does not look at the body at
  // all — so with the default, the two columns (same path, no query string)
  // collapse into ONE call and both render the same response. That is not a
  // theory: it shipped for one build and the page showed the healthy result,
  // charged, in the column that is supposed to demonstrate a refusal.
  @SingleFlight({ keyFactory: demoRunSingleFlightKey })
  @ApiOperation({
    summary: 'Run one real, paid tool call and return the provider’s response',
    description:
      'No authentication. The call is made as a real credential through the ' +
      'same session port every agent uses. The response carries the listed ' +
      'price and nothing else about money — what was actually charged is ' +
      'decided asynchronously and is reported by the verdict route.',
  })
  @ApiResponse({ status: 201, type: RunDemoResponseDto })
  async run(@Body() body: RunDemoBodyDto, @Req() request: Request): Promise<RunDemoResponseDto> {
    return (await this.demo.run({
      side: body.side,
      query: body.query,
      address: demoRateLimitAddress(request),
    })) as unknown as RunDemoResponseDto;
  }

  @Get('verdict/:intentId')
  @CacheHeader({
    maxAge: 0,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    mustRevalidate: true,
    visibility: 'private',
  })
  @ApiOperation({
    summary: 'What the checks decided about a demo call, and what the money did',
    description:
      'Returns PENDING until the worker has judged. Both terminal states below ' +
      'READY are real: a schema violation refunds synchronously and is never ' +
      'judged, and a stuck worker is reported rather than spun on. An intent ' +
      'outside the demo organization returns 404.',
  })
  @ApiResponse({ status: 200, type: DemoVerdictResponseDto })
  async verdict(
    @Param('intentId', ParseUUIDPipe) intentId: string,
  ): Promise<DemoVerdictResponseDto> {
    return (await this.verdicts.read(intentId)) as unknown as DemoVerdictResponseDto;
  }
}

/**
 * The single-flight key for `POST /run`, which **must** include the body.
 *
 * `SingleFlightInterceptor`'s default key is pathname + `x-user-id` + query
 * string and never looks at the body. The two demo columns share a path and
 * send no query string, so under the default they collapse into one call and
 * both render the same response — the healthy result, charged, in the column
 * whose entire job is to demonstrate a refusal.
 *
 * Exported so that is a test rather than a comment.
 */
export function demoRunSingleFlightKey(req: Request): string {
  const body = (req.body ?? {}) as { side?: string; query?: string };
  return `demo:run:${body.side ?? '?'}:${body.query ?? ''}`;
}

/**
 * Who to count against the rate limit: `request.ip`, never a header read here.
 *
 * Reading the first `X-Forwarded-For` entry directly trusted the client, who
 * writes it: a new value per request was a new bucket, and the per-address
 * limit was gone (review A-6). Express derives `request.ip` from the socket,
 * and walks the forwarded chain only as many hops as the app's `trust proxy`
 * setting allows, so behind the load balancer it is the address that hop saw.
 * Without `trust proxy` it is the load balancer itself, one bucket for every
 * visitor: too strict, never open.
 *
 * Exported so that is a test rather than a comment.
 */
export function demoRateLimitAddress(request: Request): string {
  return request.ip ?? 'unknown';
}
