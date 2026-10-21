import { SetMetadata } from '@nestjs/common';
import { Request } from 'express';

export interface SingleFlightCacheOptions {
  setCache: boolean;
  cacheTTLInSeconds: number;
}

export interface SingleFlightLockOptions {
  lockTTLms: number;
}

/**
 * A bounded wait for a follower (a request that lost the leader election).
 *
 * Without it a follower waits up to `lockTTLms` for the leader's publish, and
 * waits that long for nothing when the leader published before the follower
 * had subscribed. With it, right after subscribing the follower asks
 * `recheck` (did the leader leave its result somewhere?) and whether the
 * leader's lock is still held; it answers or re-elects at once, and gives up
 * after `maxWaitMs` with {@link SingleFlightWaitTimeout} rather than retry.
 */
export interface SingleFlightWaitOptions {
  maxWaitMs: number;
  /** The leader's result if it is already readable, else `undefined`. */
  recheck?: () => Promise<unknown>;
}

export interface SingleFlightOptions {
  keyFactory?: (req: Request) => string;
  cache?: SingleFlightCacheOptions;
  lock?: SingleFlightLockOptions;
  wait?: SingleFlightWaitOptions;
}

/** A follower stopped waiting for the leader (`SingleFlightWaitOptions.maxWaitMs`). */
export class SingleFlightWaitTimeout extends Error {
  constructor(readonly key: string) {
    super(`single flight: no leader result for ${key} in time`);
    this.name = 'SingleFlightWaitTimeout';
  }
}

export const SINGLEFLIGHT_META = 'singleflight';

export const SingleFlight = (options: SingleFlightOptions) =>
  SetMetadata(SINGLEFLIGHT_META, options);
