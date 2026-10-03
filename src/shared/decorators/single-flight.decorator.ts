import { SetMetadata } from '@nestjs/common';
import { Request } from 'express';

export interface SingleFlightCacheOptions {
  setCache: boolean;
  cacheTTLInSeconds: number;
}

export interface SingleFlightLockOptions {
  lockTTLms: number;
}

export interface SingleFlightOptions {
  keyFactory?: (req: Request) => string;
  cache?: SingleFlightCacheOptions;
  lock?: SingleFlightLockOptions;
}

export const SINGLEFLIGHT_META = 'singleflight';

export const SingleFlight = (options: SingleFlightOptions) =>
  SetMetadata(SINGLEFLIGHT_META, options);
