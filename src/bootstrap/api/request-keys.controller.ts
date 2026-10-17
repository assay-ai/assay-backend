import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CacheHeader } from '@shared/decorators/cache-header.decorator';
import { RawResponse } from '@shared/decorators/raw-response.decorator';
import { RequestSignerService } from '@modules/tool/request-auth/request-signer.service';

/** Public keys providers use to verify `Signature` on calls from Assay. */
@ApiTags('Public')
@Controller({ path: '.well-known', version: VERSION_NEUTRAL })
export class RequestKeysController {
  constructor(private readonly signer: RequestSignerService) {}

  @Get('assay-request-keys.json')
  @RawResponse()
  @CacheHeader({
    maxAge: 3600,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    visibility: 'public',
  })
  @ApiOperation({ summary: 'JWKS of the keys that sign outbound provider requests' })
  get(): ReturnType<RequestSignerService['jwks']> {
    return this.signer.jwks();
  }
}
