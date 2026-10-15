# Runbook: Deploying buyer debt (no platform debt)

**Use when:** deploying any build that contains buyer debt (migrations `1760600000000`,
`1760700000000` and `1760800000000`) onto a database or a fleet that ran an older build, or when
someone asks to roll such a deploy back.

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
3. Start the API, MCP and scheduler processes of the new build.
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
- If the new build must be stopped, stop it and fix forward. If an older build must run anyway,
  first write off or release every open debt by hand, then stop its scheduler before it starts.

## 4. Reconciliation note: legacy absorbed credits

Credits written by `absorb()` before this change are still in the ledger, with no buyer money
behind them. No money is moved by this deploy; they are only flagged:

```sql
SELECT organization_id, asset_id, COUNT(*) AS credits, SUM(amount) AS amount
  FROM ledger_entries
 WHERE entry_type = 'PROVIDER_CREDIT' AND chain_tx_ref LIKE 'platform_absorbed:%'
 GROUP BY organization_id, asset_id;
```

- They are reported to providers as uncollected and are not counted as a vault liability
  (`LedgerEntryRepository.sumPaidAtRedemption`).
- They still count in the provider's ledger balance. **Any payout writer must exclude them**
  (`chain_tx_ref LIKE 'platform_absorbed:%'`), and on EVM the seeded
  `legacy:pooled-vault-no-chain-transfer` credits too. Reversing them is a separate, reviewed
  change.
