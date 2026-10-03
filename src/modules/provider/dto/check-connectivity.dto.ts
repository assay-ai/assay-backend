import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUrl } from 'class-validator';

import { ConnectivityCheckResultDto } from './provider-shared.dto';

/**
 * Structural only — `http:` is accepted here on purpose. Whether the scheme is
 * acceptable for a provider endpoint is `ProviderConnectivityService`'s call
 * (`HTTPS_ONLY_POLICY`), and it answers with a named `BLOCKED` outcome and an
 * `EGRESS_SCHEME_NOT_ALLOWED` code rather than a generic 400 from the
 * validation pipe. Rejecting `http:` here would swallow that distinction
 * before the provider ever sees it. `require_tld: false` because a probe
 * target may be an IP literal or a `.test`/`.internal`-style name.
 */
const URL_VALIDATION_OPTIONS = {
  require_protocol: true,
  protocols: ['http', 'https'] as string[],
  require_tld: false,
};

/**
 * `POST /providers/me/connectivity-check` (the "Check we can reach it"
 * button).
 *
 * `endpoint` is optional: omit it to re-probe whatever is already saved on the
 * provider row (`ProviderConnectivityService.check` reads it when absent, and
 * throws `PROVIDER_ENDPOINT_NOT_DECLARED` if nothing is saved either); pass one
 * to test a URL before ever saving it, which is what the console does while
 * the provider is still typing in the field.
 */
export class CheckConnectivityBodyDto {
  @ApiPropertyOptional({
    example: 'https://api.vesseldata.example/v2/ais',
    description: 'Defaults to the endpoint already saved on the provider row.',
  })
  @IsOptional()
  @IsUrl(URL_VALIDATION_OPTIONS)
  endpoint?: string;
}

/**
 * `PUT /providers/me/endpoint` — declare and save, gated on reachability. See
 * `ProviderConnectivityService.declareEndpoint`: a check that comes back
 * anything other than `REACHABLE` is rejected on the spot and nothing is
 * written.
 */
export class DeclareEndpointBodyDto {
  @ApiProperty({ example: 'https://api.vesseldata.example/v2/ais' })
  @IsUrl(URL_VALIDATION_OPTIONS)
  endpoint: string;
}

/**
 * The connectivity check on the wire. Extends `ConnectivityCheckResultDto` — which already
 * carries `egressIps`, the allowlist published at the moment of this check —
 * with `saved`, present and `true` only on `PUT /providers/me/endpoint`'s
 * response. Absent on `POST /providers/me/connectivity-check`, which is
 * read-only and never writes the provider row.
 */
export class CheckConnectivityResponseDto extends ConnectivityCheckResultDto {
  @ApiPropertyOptional({
    description:
      'True when this check is the one that caused the endpoint to be saved onto the ' +
      'provider row. Only ever set by PUT /providers/me/endpoint.',
  })
  saved?: boolean;
}
