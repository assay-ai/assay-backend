import { validateConfig } from '@shared/utils/validate-config';
import { registerAs } from '@nestjs/config';
import { IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsString, IsOptional } from 'class-validator';

enum EEnvironment {
  Local = 'local',
  Development = 'development',
  Production = 'production',
}

enum EServiceType {
  API = 'api',
  WEBSOCKET = 'websocket',
  SCHEDULER = 'scheduler',
  ALL = 'all',
  API_AND_SCHEDULER = 'api_and_scheduler',
  API_AND_WEBSOCKET = 'api_and_websocket',
  WORKER = 'worker',
  SCHEDULER_AND_WORKER = 'scheduler_and_worker',
  /** The x402 SVM facilitator (`/verify` `/settle` `/supported`) — its own
   *  service type so the fee-payer signer never shares a process with the
   *  API. */
  FACILITATOR = 'facilitator',
  /** The MCP server — its own scaling unit: the Streamable HTTP transport
   *  is stateless per request, so it scales purely on agent traffic. */
  MCP = 'mcp',
}

class AppEnvVariables {
  @IsEnum(EEnvironment)
  @IsNotEmpty()
  @IsString()
  NODE_ENV: EEnvironment;

  @IsEnum(EServiceType)
  @IsNotEmpty()
  @IsString()
  SERVICE_TYPE: EServiceType;

  @IsNumber()
  @IsNotEmpty()
  TYPEORM_CACHE_TTL_MULTIPLIER: number;

  @IsBoolean()
  @IsNotEmpty()
  TYPEORM_CACHE_ENABLED: boolean;

  @IsBoolean()
  @IsOptional()
  HTTP_CACHE_ENABLED?: boolean;

  @IsBoolean()
  @IsOptional()
  BROWSER_CACHE_ENABLED?: boolean;

  @IsBoolean()
  @IsOptional()
  CDN_CACHE_ENABLED?: boolean;
}

/**
 * Express `trust proxy`, from `API_TRUST_PROXY_HOPS`: how many proxies (load
 * balancers) sit in front of the API. With `n`, Express trusts the last `n`
 * entries of `X-Forwarded-For`, and `request.ip` is the client as the
 * outermost of those proxies saw it; with `0` (the default, and
 * right for local runs with no proxy) the header is ignored and `request.ip`
 * is the socket's peer. The operator sign-in throttle keys on `request.ip`, so
 * behind a balancer an unset value puts every caller on one counter, and a
 * value higher than the real hop count lets a caller choose their own address.
 * Set it to exactly the number of hops in the deployment.
 */
export function parseTrustProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`API_TRUST_PROXY_HOPS must be a whole number of hops, got "${raw}"`);
  }
  return hops;
}

/**
 * Refuse to start the API in production with `API_TRUST_PROXY_HOPS` unset
 * (review N-4). Unset there almost always means "forgot", and behind a
 * balancer it turns every IP-keyed limit — the operator sign-in throttle, the
 * public demo — into one bucket for everybody. An explicit `0` is a decision
 * (no proxy in front) and is accepted.
 */
export function assertTrustProxyHopsConfigured(
  raw = process.env.API_TRUST_PROXY_HOPS,
  nodeEnv = process.env.NODE_ENV,
): void {
  if (nodeEnv === 'production' && (raw === undefined || raw.trim() === '')) {
    throw new Error(
      'API_TRUST_PROXY_HOPS must be set when NODE_ENV=production: the number of proxies ' +
        'in front of the API, or 0 when there is none',
    );
  }
}

/**
 * The browser origins a dashboard runs on locally: the console apps on ports
 * 4000-4005, by name and by loopback address. They are the default only
 * outside production; production has no default (see `parseCorsAllowedOrigins`).
 */
export const DEV_CORS_ALLOWED_ORIGINS: readonly string[] = [
  4000, 4001, 4002, 4003, 4004, 4005,
].flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

/**
 * `CORS_ALLOWED_ORIGINS`: a comma-separated list of exact origins
 * (`scheme://host[:port]`, no path, no trailing slash) whose browser pages may
 * call the API with credentials. Only a listed origin is reflected in
 * `Access-Control-Allow-Origin`; any other origin gets no CORS headers and the
 * browser refuses to read the response.
 *
 * `*` is refused: together with `Access-Control-Allow-Credentials: true` it
 * would let any website make calls as the signed-in user (R17-R-02).
 *
 * Unset or blank: the local dashboard origins (`DEV_CORS_ALLOWED_ORIGINS`)
 * outside production, and a refusal to start in production, where an unset
 * value almost always means "forgot" and would otherwise leave the dashboard
 * broken in a way that only shows in a browser.
 */
export function parseCorsAllowedOrigins(
  raw: string | undefined = process.env.CORS_ALLOWED_ORIGINS,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string[] {
  if (raw === undefined || raw.trim() === '') {
    if (nodeEnv === 'production') {
      throw new Error(
        'CORS_ALLOWED_ORIGINS must be set when NODE_ENV=production: a comma-separated list ' +
          'of the dashboard origins, e.g. https://app.example.com',
      );
    }
    return [...DEV_CORS_ALLOWED_ORIGINS];
  }
  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const origin of origins) {
    if (origin === '*') {
      throw new Error('CORS_ALLOWED_ORIGINS must list exact origins; "*" is not allowed');
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CORS_ALLOWED_ORIGINS has an entry that is not an origin: "${origin}"`);
    }
    if (parsed.origin !== origin) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS entries must be bare origins like "${parsed.origin}", got "${origin}"`,
      );
    }
  }
  return origins;
}

const appConfig = registerAs('app', () => {
  validateConfig(process.env, AppEnvVariables);

  return {
    nodeEnv: process.env.NODE_ENV,
    serviceType: process.env.SERVICE_TYPE,
    api: {
      port: parseInt(process.env.API_PORT, 10),
      trustProxyHops: parseTrustProxyHops(process.env.API_TRUST_PROXY_HOPS),
      typeormCacheEnabled: process.env.TYPEORM_CACHE_ENABLED === 'true',
      typeormCacheTtlMultiplier: parseInt(process.env.TYPEORM_CACHE_TTL_MULTIPLIER, 10),
      httpCacheEnabled: process.env.HTTP_CACHE_ENABLED !== 'false',
      browserCacheEnabled: process.env.BROWSER_CACHE_ENABLED !== 'false',
      cdnCacheEnabled: process.env.CDN_CACHE_ENABLED !== 'false',
    },
    websocket: {
      port: parseInt(process.env.WEBSOCKET_PORT, 10),
    },
    worker: {
      port: parseInt(process.env.WORKER_PORT, 10),
      concurrency: parseInt(process.env.WORKER_CONCURRENCY || '4', 10),
    },
    scheduler: {
      port: parseInt(process.env.SCHEDULER_PORT, 10),
      enabled: process.env.SCHEDULER_ENABLED !== 'false',
    },
    facilitator: {
      port: parseInt(process.env.FACILITATOR_PORT || '3100', 10),
    },
    mcp: {
      port: parseInt(process.env.MCP_PORT || '3200', 10),
    },
  };
});

export { EEnvironment, EServiceType, appConfig };
