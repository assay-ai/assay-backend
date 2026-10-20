# Runbook: Deploying buyer debt (no platform debt)

**Use when:** deploying any build that contains buyer debt (migrations `1760600000000`,
`1760700000000`, `1760800000000` and `1760900000000`) onto a database or a fleet that ran an older
build, or when someone asks to roll such a deploy back.

`1760900000000` relaxes `trg_payment_intents_voucher_seq_immutable` for exactly one write: a
lapsed debt's replacement voucher, at a higher seq, once the old voucher is past its on-chain
deadline (`expires_at` + 1,920 s). Without it every `POST /escrow/debts/:id/voucher` fails, so no
debt can be settled (BUG-R17f-01). Its `down` restores the strict trigger and nothing else.

Buyer debt replaced `absorb()`: an unredeemable rail-B voucher no longer credits the provider from
platform funds. The provider forfeits it when it caused the failure; otherwise the call becomes
**buyer debt** (the buyer's hold stays open, its paid calls are refused with
`PAYMENT_DEBT_OUTSTANDING` until it re-signs). A debt not settled within 30 days is written off:
the hold is released and the provider is not paid. Until the contract change ("signed means
collectable") ships, a written-off debt **keeps refusing the payer's paid calls** (wallet and
organization) until the buyer re-signs it. The platform never pays or owes a provider.

## 1. Before the deploy: count what the first pass will touch

Run on the target database (read only; works before the migrations):

```sql
SELECT
  COUNT(*) FILTER (WHERE status = 'SETTLED' AND hold_released_at IS NULL
                     AND expires_at < now() - interval '1800 seconds') AS settled_dead_voucher,
  COUNT(*) FILTER (WHERE status = 'SETTLED' AND hold_released_at IS NULL)  AS settled_open_hold,
  COUNT(*) FILTER (WHERE status = 'VERIFYING'
                     AND expires_at < now() - interval '900 seconds')      AS verifying_past_deadline
  FROM payment_intents
 WHERE rail = 'RAIL_B_VOUCHER' AND hold_id IS NOT NULL AND voucher_seq IS NOT NULL;
```

- `settled_dead_voucher`: served calls whose voucher the chain no longer redeems. The first
  redemption pass makes each one buyer debt (or a provider forfeit). Every payer among them is
  refused paid calls until it re-signs.
- `verifying_past_deadline`: calls still waiting for a verdict. The first expiry sweep settles them
  as served and unverified; those past `expiresAt + 1740 s` become debt at once.
- If either number is not 0, tell the owners of those payers before the deploy, or release the rows
  by hand first.

## 2. Deploy order

1. **Stop every scheduler** (`AppSchedulerModule`) running an older build. An old scheduler still
   runs `absorb()`: it picks up every open debt (`SETTLED`, hold open, voucher dead) and writes a
   `PROVIDER_CREDIT platform_absorbed:…` for each one, i.e. the platform pays the provider. Never
   run two versions of the scheduler at the same time, not even during a rolling deploy.
2. **Run the migrations** (`yarn migration:run:prod`; `start:prod` runs them first too). The
   processes refuse to boot without them (`PaymentIntentRepository.assertBuyerDebtSchema`): every
   paid call reads the debt columns, so without them every paid call would fail with a 500.
   The public Explorer index (`1760400000000-public-explorer-index`) is built with
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS` outside a transaction, so it does not block writes to
   `payment_intents`; on a large table it can still take a while. To keep it out of the deploy
   window, build it by hand beforehand with the same statement:
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_payment_intents_paid_held_created" ON
   "payment_intents" ("created_at") WHERE "call_class" = 'PAID' AND "hold_id" IS NOT NULL;`
   The migration then finds it and does nothing. If a concurrent build fails, Postgres leaves an
   INVALID index; the migration drops and rebuilds it. A database that already ran the earlier,
   blocking version of this migration skips it (same name and timestamp).
3. Start the API, MCP and scheduler processes of the new build. Set `CORS_ALLOWED_ORIGINS` on the
   API and WebSocket processes first: with `NODE_ENV=production` (the `Dockerfile` default) they
   refuse to start without it. List every exact frontend origin, comma-separated: the custom
   domains and the `*.pages.dev` origins of the production and develop Pages projects (for
   example `https://app.example.com,https://assay-frontend.pages.dev`). Wildcards are not
   supported; an origin left off gets no CORS headers and every browser call from it fails.
4. Ship the frontend change (debt banner, "Sign to settle", the debt states `OPEN`, `REPLACING`,
   `WRITTEN_OFF`) with or before the backend. Without it a human buyer can settle only through the
   REST API (`GET /escrow/debts`, `POST /escrow/debts/:id/voucher-intent`,
   `POST /escrow/debts/:id/voucher`).

## 3. Rollback: do not go past these migrations

- **No rollback to a build that has `absorb()`.** Any build before the buyer-debt merge reads every
  open debt as awaiting redemption and absorbs it from platform funds.
- **Never run the `down` of `1760700000000` or `1760800000000`.** Dropping `redemption_lapsed_at`
  makes every debt look like a voucher awaiting redemption again, which an old build absorbs; and
  dropping `redemption_replaced_at` loses which debts are being collected.
- **`migration:revert` order.** `1760400000000` is shared by `public-explorer-index` and
  `slash-part-cancel-reason`. `slash-part-cancel-reason` was already on main, so it ran long
  ago. TypeORM matches executed migrations by name, so `public-explorer-index` still runs, but on
  a database that had already run `1760600000000`-`1760900000000` it runs after them, and the
  executed-at order is what `migration:revert` undoes. The first revert after this deploy
  therefore drops the Explorer index, not `VoucherSeqDebtReplacement` or
  `PaymentIntentDebtReplacing`. Check `SELECT * FROM migrations ORDER BY id DESC LIMIT 3` before
  reverting anything.
- If the new build must be stopped, stop it and fix forward. If an older build must run anyway,
  first write off or release every open debt by hand, then stop its scheduler before it starts.
