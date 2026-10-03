export const CACHE_KEYS = {
  HTTP_CACHE: {
    CUSTOM: (key: string, userId?: string | null) =>
      `http-cache:custom:${key}${userId ? `:${userId}` : ''}`,
    AUTO: (path: string, queryString?: string, userId?: string | null) =>
      `http-cache:auto:${path}${queryString ? `:${queryString}` : ''}${userId ? `:${userId}` : ''}`,
  },
};

export const CACHE_TTL = {
  SHORT: 60,
  MEDIUM: 300,
  LONG: 3600,
  HALF_HOUR: 1800,
  DAY: 86400,
};
