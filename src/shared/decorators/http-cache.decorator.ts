import { SetMetadata } from '@nestjs/common';

export const HTTP_CACHE_TTL_KEY = 'http_cache_ttl';
export const HTTP_CACHE_KEY_KEY = 'http_cache_key';
export const HTTP_NO_CACHE_KEY = 'http_no_cache';

/**
 * Set cache TTL for HTTP endpoint
 * @param ttl - Time to live in seconds
 */
export const HttpCacheTTL = (ttl: number) => SetMetadata(HTTP_CACHE_TTL_KEY, ttl);

/**
 * Set custom cache key for HTTP endpoint
 * @param key - Custom cache key (will be prefixed with 'http:')
 */
export const HttpCacheKey = (key: string) => SetMetadata(HTTP_CACHE_KEY_KEY, key);

/**
 * Disable cache for specific endpoint
 */
export const NoHttpCache = () => SetMetadata(HTTP_NO_CACHE_KEY, true);
