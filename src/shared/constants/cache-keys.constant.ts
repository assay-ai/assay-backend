export const CACHE_KEYS = {
  HTTP_CACHE: {
    CUSTOM: (key: string, userId?: string | null) =>
      `http-cache:custom:${key}${userId ? `:${userId}` : ''}`,
    AUTO: (path: string, queryString?: string, userId?: string | null) =>
      `http-cache:auto:${path}${queryString ? `:${queryString}` : ''}${userId ? `:${userId}` : ''}`,
  },
};
