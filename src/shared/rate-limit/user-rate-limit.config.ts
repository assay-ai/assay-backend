/**
 * The per-caller rate limits of the dashboard API: every number, and which
 * route counts against which one. **The only place a route is put in a
 * category**; `UserRateLimitInterceptor` reads this and nothing else.
 *
 * ## Categories
 *
 * | Category | Applies to | Limit | Counted per |
 * |---|---|---|---|
 * | A1 read | every authenticated GET not listed below | 180 / min | caller |
 * | A2 heavy read | the GETs in {@link HEAVY_READS} | 30 / min, **each route its own window** | caller |
 * | A3 export | `GET /providers/me/calls/export` | 5 / min, 1 at a time | organization |
 * | W1 write | every authenticated POST/PUT/PATCH/DELETE not listed below | 20 / min | caller |
 * | W2 create | credential mint, tool request, provider registration, handle | per route | organization |
 * | M1 money | deposit create/settle/broadcast, debt voucher, withdraw intent | per route | account / credential |
 * | M2 chain | stake intents, slash dispute intent, arbiter ruling intent | per route | organization / operator |
 * | AU auth | `POST /auth/wallet/link` | 30 / min | client address |
 *
 * A request counts against exactly one window: a route listed here is not
 * also counted in A1 or W1.
 *
 * **"Caller"** is the person or the key behind the request: a person's
 * console session is `organization:agent` (their agent), an agent API key or
 * OAuth grant is its credential id, and an operator is their operator id. Two
 * people of one organization have a window each.
 *
 * ## What is not counted here
 *
 * - Routes with no caller: the public reads (`PublicReadRateLimitInterceptor`,
 *   120 / min / address), `/health`, the well-known documents, the operator
 *   sign-in (its own throttle). A request whose guard refused it (401/403)
 *   never reaches the interceptor, so it is not counted either.
 * - OAuth (`/oauth/*`) and MCP, which keep their own limiters.
 * - {@link OWN_LIMITER_ROUTES}: routes behind a limiter of their own that is
 *   stricter or shaped differently (the voucher sequence allocator's 120 / min
 *   per credential, the relayed escrow intents' hourly budget).
 *
 * ## When Redis is out
 *
 * Every window here fails **open to the in-process window**, the money
 * category included: each replica then counts alone, which is still a limit.
 * These windows bound cost (queries, RPC, rows created), not money. What
 * protects money is the ledger, the voucher sequence and the spend policy, all
 * of which stay in force; refusing every deposit for the length of a Redis
 * blip would hurt buyers and protect nothing.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Who one window is counted for. */
export enum RateSubject {
  /** The person (`organization:agent`), the credential, or the operator. */
  CALLER = 'caller',
  ORGANIZATION = 'organization',
  /** The session's agent account (CAIP-10), the account money moves on. */
  ACCOUNT = 'account',
  CREDENTIAL = 'credential',
  OPERATOR = 'operator',
  /** The client address, for a route that runs before there is a session. */
  ADDRESS = 'address',
}

export interface RateRule {
  /** The window's name in Redis. Routes that share a name share a count. */
  readonly bucket: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly subject: RateSubject;
  /** At most this many in flight at once per subject. */
  readonly concurrent?: number;
}

/** A1: every authenticated read not listed below; one window across all of them. */
export const READ_RULE: RateRule = Object.freeze({
  bucket: 'read',
  limit: 180,
  windowMs: MINUTE_MS,
  subject: RateSubject.CALLER,
});

/** W1: every authenticated write not listed below; one window across all of them. */
export const WRITE_RULE: RateRule = Object.freeze({
  bucket: 'write',
  limit: 20,
  windowMs: MINUTE_MS,
  subject: RateSubject.CALLER,
});

export const HEAVY_READ_LIMIT = 30;

/**
 * A2: reads that aggregate, fan out to the chain, or loop per row. Each has
 * a window of its own, so polling one (a deposit wait on `/balances`) does not
 * starve the others.
 */
export const HEAVY_READS: readonly string[] = [
  'GET /balances',
  'GET /withheld',
  'GET /statements/balance',
  'GET /receipts/summary',
  'GET /receipts/summary/daily',
  'GET /overview',
  'GET /providers/me/earnings',
  'GET /providers/me/reconciliation',
  'GET /providers/me/payouts',
  'GET /providers/me/stake',
  'GET /providers/me/slash-proposals/:proposalId',
  'GET /agents/:agentId/servers',
  'GET /agents/:agentId/access',
  'GET /free-quota',
  'GET /escrow/delegates',
  'GET /agents/me/delegate',
  'GET /operator/health',
  'GET /operator/arbiter/disputes',
  'GET /operator/cases',
  'GET /operator/call-disputes',
  'GET /operator/promotions',
  'GET /operator/promotions/similar/:id',
];

/** The routes with a rule of their own, keyed `METHOD /path` as the controllers declare them. */
export const ROUTE_RULES: Readonly<Record<string, RateRule>> = Object.freeze({
  ...Object.fromEntries(
    HEAVY_READS.map((route) => [
      route,
      {
        bucket: `heavy:${route.slice(route.indexOf(' ') + 1)}`,
        limit: HEAVY_READ_LIMIT,
        windowMs: MINUTE_MS,
        subject: RateSubject.CALLER,
      },
    ]),
  ),

  // A3 — up to 50k rows a run.
  'GET /providers/me/calls/export': {
    bucket: 'export',
    limit: 5,
    windowMs: MINUTE_MS,
    subject: RateSubject.ORGANIZATION,
    concurrent: 1,
  },

  // W2 — rows that outlive the request.
  'POST /agents/:agentId/credentials': {
    bucket: 'credential-mint',
    limit: 10,
    windowMs: HOUR_MS,
    subject: RateSubject.ORGANIZATION,
  },
  'POST /tool-requests': {
    bucket: 'tool-request',
    limit: 20,
    windowMs: DAY_MS,
    subject: RateSubject.ORGANIZATION,
  },
  'POST /providers': {
    bucket: 'provider-register',
    limit: 10,
    windowMs: HOUR_MS,
    subject: RateSubject.ORGANIZATION,
  },
  'PUT /org/handle': {
    bucket: 'handle',
    limit: 10,
    windowMs: HOUR_MS,
    subject: RateSubject.ORGANIZATION,
  },

  // M1 — money intents.
  'POST /deposits': {
    bucket: 'deposit',
    limit: 10,
    windowMs: MINUTE_MS,
    subject: RateSubject.ACCOUNT,
  },
  // One window for both: the console's pending-transaction poll asks every
  // 8 s, at most five times, per deposit.
  'POST /deposits/:depositId/settle': {
    bucket: 'deposit-confirm',
    limit: 30,
    windowMs: MINUTE_MS,
    subject: RateSubject.ACCOUNT,
  },
  'POST /deposits/:depositId/broadcast': {
    bucket: 'deposit-confirm',
    limit: 30,
    windowMs: MINUTE_MS,
    subject: RateSubject.ACCOUNT,
  },
  // The same budget as its voucher-intent (`NEXT_SEQ_RATE_LIMITS`).
  'POST /escrow/debts/:intentId/voucher': {
    bucket: 'debt-voucher',
    limit: 120,
    windowMs: MINUTE_MS,
    subject: RateSubject.CREDENTIAL,
  },
  // Up to seven RPC reads, and it may send a gas grant.
  'POST /escrow/withdrawals/intent': {
    bucket: 'withdraw-intent',
    limit: 10,
    windowMs: MINUTE_MS,
    subject: RateSubject.ACCOUNT,
  },

  // M2 — chain reads and writes on the caller's behalf.
  ...Object.fromEntries(
    ['deposit', 'open-stake', 'unstake', 'withdraw'].map((kind) => [
      `POST /providers/me/stake/${kind}-intent`,
      {
        bucket: 'stake-intent',
        limit: 30,
        windowMs: MINUTE_MS,
        subject: RateSubject.ORGANIZATION,
      },
    ]),
  ),
  // Up to 64 RPC reads in parallel.
  'POST /providers/me/slash-requests/dispute-intent': {
    bucket: 'slash-dispute-intent',
    limit: 10,
    windowMs: MINUTE_MS,
    subject: RateSubject.ORGANIZATION,
  },
  'POST /operator/arbiter/ruling-intent': {
    bucket: 'arbiter-ruling-intent',
    limit: 10,
    windowMs: MINUTE_MS,
    subject: RateSubject.OPERATOR,
  },

  // AU — the console retries every 3 s for 60 s while a sign-in settles.
  'POST /auth/wallet/link': {
    bucket: 'wallet-link',
    limit: 30,
    windowMs: MINUTE_MS,
    subject: RateSubject.ADDRESS,
  },

  // Reads sent as a POST for their body; the editors call them on a debounce.
  'POST /providers/me/tool-bindings/validate-mapping': READ_RULE,
  'POST /providers/me/slash-requests/lookup': READ_RULE,
  'POST /mcp-urls/preview': READ_RULE,
});

/**
 * Routes this limiter leaves alone because a limiter of their own already
 * bounds them.
 */
export const OWN_LIMITER_ROUTES: readonly string[] = [
  // `NEXT_SEQ_RATE_LIMITS`, 120 / min per credential, fails closed. The
  // agent's payment path: a second, shared read window must not refuse it.
  'GET /escrow/next-seq',
  'POST /escrow/debts/:intentId/voucher-intent',
  // `RelayedIntentRateLimiter`: 20 / hour per account, 50 / hour per organization.
  'POST /escrow/limits',
  'POST /escrow/withdrawals/request',
  'POST /escrow/delegates',
  'POST /escrow/delegates/intent',
  'POST /escrow/delegates/revoke',
  'POST /escrow/delegates/revoke-intent',
];

/**
 * Path prefixes this limiter never counts: public reads (their own
 * per-address window), health, well-known documents, OAuth and MCP (their own
 * limiters), and the operator sign-in (its own throttle).
 */
export const EXEMPT_PATH_PREFIXES: readonly string[] = [
  '/public/',
  '/health',
  '/.well-known/',
  '/oauth/',
  '/mcp',
  '/operator/auth/',
];

/**
 * Slots for a concurrency limit live this long at most, so a process that dies
 * mid-export does not hold the organization's slot for good.
 */
export const CONCURRENT_SLOT_TTL_MS = 2 * MINUTE_MS;

/** Subjects the in-process fallback tracks at once. */
export const USER_RATE_MAX_KEYS = 20_000;

/**
 * `API_USER_RATE_LIMITS_ENABLED`: on unless set to `false`. Tests that drive
 * many requests through one session turn it off rather than raising a limit.
 */
export function parseUserRateLimitsEnabled(
  raw: string | undefined = process.env.API_USER_RATE_LIMITS_ENABLED,
): boolean {
  return raw?.trim().toLowerCase() !== 'false';
}
