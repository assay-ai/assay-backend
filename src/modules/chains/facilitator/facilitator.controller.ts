import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';

import { FacilitatorRequestBodyDto } from './dto/facilitator-request.dto';
import {
  FACILITATOR_ROUTES,
  SettleResponseBody,
  SupportedResponseBody,
  VerifyResponseBody,
} from './facilitator.wire';
import { FacilitatorService } from './facilitator.service';

/**
 * `POST /verify`, `POST /settle`, `GET /supported` — exactly the shapes in
 * `facilitator.wire.ts`, unwrapped. This process does not run
 * `TransformInterceptor` (see `bootstrap/facilitator/main.ts`): a standard
 * x402 client parses these bodies directly, and wrapping them in `{ data,
 * statusCode, message }` would make this facilitator speak a dialect no other
 * x402 client understands.
 *
 * `@HttpCode(200)` on `/verify` and `/settle` is not the Nest default for
 * `@Post` (201) — both endpoints answer a question, they do not create a
 * resource, and `isValid: false` / `success: false` is itself a successful
 * answer (`facilitator.wire.ts`'s `VerifyResponseBody` doc comment).
 */
@Controller()
export class FacilitatorController {
  constructor(private readonly facilitatorService: FacilitatorService) {}

  @Post(FACILITATOR_ROUTES.VERIFY)
  @HttpCode(200)
  async verify(@Body() body: FacilitatorRequestBodyDto): Promise<VerifyResponseBody> {
    return this.facilitatorService.verify(body);
  }

  @Post(FACILITATOR_ROUTES.SETTLE)
  @HttpCode(200)
  async settle(@Body() body: FacilitatorRequestBodyDto): Promise<SettleResponseBody> {
    return this.facilitatorService.settle(body);
  }

  @Get(FACILITATOR_ROUTES.SUPPORTED)
  async supported(): Promise<SupportedResponseBody> {
    return this.facilitatorService.supported();
  }
}
