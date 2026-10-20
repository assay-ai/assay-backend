import { RequestMethod } from '@nestjs/common';

import { buildGlobalPrefixOptions } from '../../../src/bootstrap/api/global-prefix';
import { RequestKeysController } from '../../../src/bootstrap/api/request-keys.controller';
import { RequestSignerService } from '@modules/tool/request-auth/request-signer.service';
import { CACHE_HEADER_KEY } from '@shared/decorators/cache-header.decorator';
import { RAW_RESPONSE_KEY } from '@shared/decorators/raw-response.decorator';

describe('RequestKeysController', () => {
  const signer = new RequestSignerService([
    { keyId: 'k1', seed: new Uint8Array(32).fill(7), claimedPublicKey: null },
  ]);
  const controller = new RequestKeysController(signer);

  it('returns the signer JWKS', () => {
    expect(controller.get()).toEqual(signer.jwks());
  });

  it('is raw and cached for an hour', () => {
    expect(Reflect.getMetadata(RAW_RESPONSE_KEY, RequestKeysController.prototype.get)).toBe(true);
    expect(
      Reflect.getMetadata(CACHE_HEADER_KEY, RequestKeysController.prototype.get),
    ).toMatchObject({
      maxAge: 3600,
      visibility: 'public',
    });
  });

  it('is excluded from the /api prefix', () => {
    expect(buildGlobalPrefixOptions().exclude).toEqual([
      { path: '.well-known/assay-request-keys.json', method: RequestMethod.GET },
    ]);
  });
});
