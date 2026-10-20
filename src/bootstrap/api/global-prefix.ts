import { RequestMethod } from '@nestjs/common';

/** Everything lives under `/api` except the provider-facing JWKS. */
export function buildGlobalPrefixOptions() {
  return {
    exclude: [{ path: '.well-known/assay-request-keys.json', method: RequestMethod.GET }],
  };
}
