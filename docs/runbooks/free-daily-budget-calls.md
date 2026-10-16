# Runbook: `free_daily_budget` is a call count

**Use when:** deploying the build that fixed BUG-R17g-01 onto a database that older builds (and
the older provider console) wrote to.

`tool_bindings.free_daily_budget` is **the most free calls a binding serves per day, across all
agents**. Enforcement (`FreeQuotaService`), the default (`DEFAULT_PROVIDER_DAILY_BUDGET = 50_000`
calls) and the published "N free per day" (`freeCallsPerDay`) always read it as a call count. The
API and the provider console used to describe and write it as **money in minor units**: a
provider who typed "5" (USDC) in "Daily free budget" stored `5000000`, which allows 5,000,000 free
calls a day.

From this build on, the API takes `freeDailyBudget` as a whole number of calls (1 to
2,147,483,647, or `null` for the platform default) and refuses a string. The column keeps its
`numeric(78,0)` type; no migration changes it and **nothing converts existing rows**.

## Before or right after the deploy: review the rows the old console wrote

Read only:

```sql
SELECT id, organization_id, tool_id, status, pricing_mode, price_amount, asset_id,
       free_quota_per_agent, free_daily_budget,
       free_daily_budget >= 1000000 AS looks_like_money,
       free_daily_budget > 2147483647 AS above_new_max
  FROM tool_bindings
 WHERE free_daily_budget IS NOT NULL
 ORDER BY free_daily_budget DESC;
```

- No rows: nothing to do.
- `looks_like_money` true: most likely a money amount from the old console (USDC has 6 decimals,
  so `1000000` was $1). Read as calls, it is a very high cap, so that binding effectively had no
  binding-wide limit. Ask the provider for the call count they meant, and have them set it on the
  binding's Free tier screen (or clear it to use the default).
- A small value (for example `100`, which the old console saved for $0.0001): the binding really
  serves only that many free calls a day. Confirm with the provider.
- `above_new_max` true: the value still works for enforcement, but the console cannot save it
  again as it is. The provider must enter a new count.

Do not rewrite these rows yourself: only the provider knows what they meant, and a guess changes
what their binding gives away.
