# Public protocol analytics

`GET /api/v1/public/analytics?range=7d&asset=<CAIP-19>` is an anonymous read of
recorded protocol activity. Supported ranges are `7d`, `30d` (default), `90d`
and `all`. The optional asset must be registered on an enabled chain. Without
an asset parameter the first registered asset on an enabled chain is selected;
`assets` describes every available selection. Assets, chains, tokens and test
networks are never summed together.

The normal API envelope wraps `ProtocolAnalyticsResponseDto`. The DTOs appear
in Swagger and include explicit atomic-unit amount strings, counts, nullable
rates, UTC windows, daily chart rows, public tool rankings, coarse recent
payment groups and buyer escrow ledger balances. No schema migration is needed
for new financial records; the accompanying migration adds two concurrent read
indexes. Existing call/payment/ledger writers are unchanged.

## Freshness

- Redis snapshot lifetime: **2,000 ms**, measured from snapshot generation,
  including database latency. Old timestamps are rejected even if an old Redis
  entry reappears. No extra in-memory result cache or stale-if-error fallback.
- Concurrent reads of one asset/range share the in-flight load within a process.
- Redis reads/writes have 150 ms deadlines. An outage falls back to PostgreSQL;
  database failure remains an HTTP error, never a successful response of zeros.
- Browser and CDN responses use `no-store`. The public per-address read limiter
  still applies. PostgreSQL reads have a 5-second statement deadline.
- The portal polls every 3 seconds while visible, refetches on focus, and has a
  manual Refresh button. Errors hide cached figures; refresh can be retried.
- This is a snapshot of database records, not a direct RPC or proof of balance.

## Accounting definitions

The population consists of positive-price `PAID` intents with an actual ledger
hold in the selected asset, created before the snapshot. `FREE`, `TEST`,
`EXPLORATION` and unfunded attempts are excluded. Time ranges include the partial
current UTC day. The previous period has equal elapsed duration. `all` has no
comparison, and its chart is limited to the latest 90 days while totals cover
all recorded history. Charts use UTC dates regardless of the database session
zone. Adoption counts distinct payer wallets, not distinct humans or customers.

Payments are grouped by **call creation time**, with their currently recorded
outcome. Consequently historical cohorts may change as pending calls finish.

- Volume: sum of listed funded call prices, before collection/refund/release.
- Revenue/provider earnings: actual `PLATFORM_FEE`/`PROVIDER_CREDIT` ledger
  entries for collected intents. Passed verification, unredeemed vouchers,
  uncollected debt, forfeits and written-off debt do not generate revenue here.
- Refunded: funded prices of booked refunds whose hold release is recorded.
- Pending: funded prices with an open ledger hold or an on-chain dispute hold
  still marked HELD, excluding collected/refunded payments.
- Other releases (`notCharged`): the residual after revenue, provider earnings,
  refunds and pending. All five buckets reconcile to funded volume.
- Pass rate: collected / (collected + refunded). It is `null`, not 0% or 100%,
  when no completed payments exist.
- Escrow: available/held **ledger** balances of accounts registered in
  `buyer_escrows`, excluding unrelated provider/platform balances. These
  balances do not depend on the selected historical window.

Amounts remain PostgreSQL numeric / integer strings on the wire. Frontend
money arithmetic uses a 100-digit Decimal context; only chart coordinates and
rates use JavaScript numbers. Counts are bounded to PostgreSQL integer range,
so overflow fails instead of silently rounding a large count.

## Public projection

Every eligible recorded payment contributes to protocol totals under the same
accounting rules. No additional organization configuration is required. Free calls retain their separate activity records and are not
counted as paid activity or revenue.

Top tools include only currently listed active/deprecated standard tools or
approved provider tools. A tool group is published only with at least five
buyer organizations.
Recent payments are **daily tool aggregates** subject to the same rule per
day/tool, with a limit of 12 rows. Private/unapproved tools and undersized groups
are omitted; `withheldForPrivacy` indicates suppression. This endpoint is a
separate aggregate projection and does not relax `/public/not-charged`'s
existing delayed feed rules.

No buyer/agent/organization IDs, wallet addresses, intent IDs, credentials,
transaction references, exact individual payment timestamps or endpoints are
selected into the response. There is intentionally no individual-payment feed.
An empty database is `OK` with genuine zeros and nullable rates. No available
enabled asset is `UNAVAILABLE` with null figures. Transport/database failures
are errors. The frontend preserves these distinctions instead of substituting
placeholder amounts or carrying values across asset/range changes.

## Validation

Unit tests cover query validation, UTC windows,
Redis expiry/corruption/outage/deadlines, single-flight and failure handling.
Integration tests migrate a dedicated local PostgreSQL database using the real
migrations and exercise aggregates, large integers, asset isolation, public
projection, consistent inclusion across buyer organizations, and an unauthenticated
HTTP read with real Redis expiry and a newly inserted payment.

Run the suite only against a local test PostgreSQL server:

```sh
yarn jest --config test/jest-unit.json --runInBand test/unit/protocol-analytics
DATABASE_HOST=127.0.0.1 DATABASE_PORT=55432 \
  ANALYTICS_TEST_REDIS_PORT=56379 \
  yarn jest --config test/jest-integration.json --runInBand test/integration/protocol-analytics
```

Use the local test server's normal credentials through environment variables.
The integration suite uses only `assay_protocol_analytics_test`, refuses remote
PostgreSQL hosts, uses unique fixture asset IDs and never clears shared Redis.
