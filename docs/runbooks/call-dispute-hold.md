# Call disputes and the payment hold (G3.B1)

A buyer may dispute a paid call. While the call's payment is held — the
dispute window — an upheld dispute refunds it in full. This runbook covers the
moving parts an operator or a deployer touches.

## How the money moves

| Rail | Held where | Collected by | Refunded by |
|---|---|---|---|
| B (voucher) | The escrow's `held[payer][seq]`, out of the buyer's balance | `HeldCollectionJob` (`collectHeldBatch`), after `collectableAt` | The scheduler's refund job (`refundHeld`), for an upheld dispute |
| A (facilitator) | The provider's ledger credit, withheld | `HeldCollectionJob`, after `CALL_DISPUTE_HOLD_WINDOW_MINUTES` | The decision itself (ledger release) |

- The provider is credited on `HeldCollected`, never on `VoucherRedeemed`.
- Whether a redemption was held is decided from its receipt: a `PaymentHeld`
  log means held; a bare `VoucherRedeemed` means paid at redemption (before the
  upgrade). On a chain listed in `EVM_HOLD_LIVE_CHAINS`, anything else is retried.
- A refund does not restore the buyer's window or spend caps.
- Past the chain's 7-day timeout anyone may collect a held payment for the
  provider. The platform never collects one an open or upheld dispute still
  claims; it pages (`held_payment_past_timeout`) and books the collect when it
  lands. The dispute is then `NOT_REFUNDABLE`.

## Keys

The redeemer key (`EVM_REDEEMER_KEYS`) can now pay providers (`collectHeld`) and
refund buyers (`refundHeld`). Only the scheduler holds it. The API decides
disputes and leaves rail-B refunds `PENDING`; the scheduler's refund job sends
them every minute, with back-off on failure. Redemption (second 0), collection
(second 30) and refunds (second 45) share the key, so each pass sends at most
one batch per asset, simulates every send first, and gives a send up rather than
queue long behind the others.

## Turning the hold on for a chain

1. Add the chain's CAIP-2 id to `EVM_HOLD_LIVE_CHAINS` on the API and the
   scheduler IN THE SAME DEPLOY as the AssayEscrow / AssayConfig upgrade (contract
   work) — not after it.
2. The backend does not depend on the flag being in time: a redemption's
   receipt is classified from the logs the ESCROW emitted (`PaymentHeld` means
   held, before the flag flips too), a reverted receipt is never paid or held,
   and the escrow is probed once a minute for the hold's own view
   (`totalHeld()`); once it answers, the hold is live on that chain for good and
   an undecided redemption is retried, never paid at once.
3. A landing seen without its transaction hash is placed from the escrow's
   recent logs for that payer and seq; one that still cannot be placed after 5
   tries pages `redemption_unclassified` and is never credited until a human
   resolves it.

## The decision SLA

| From filing | What happens |
|---|---|
| 24 h | No provider reply: the provider is marked silent and can no longer reply |
| 48 h | An operator is paged |
| 72 h | Auto-upheld (logged as `S-14` under the system actor) when the refund is guaranteed, the provider stayed silent and the amount is below `CALL_DISPUTE_TWO_PERSON_THRESHOLD`; otherwise paged |
| 6 d | Paged again, before the chain timeout |

Auto-upholds against one provider are capped per day
(`CALL_DISPUTE_MAX_AUTO_UPHOLDS_PER_PROVIDER_PER_DAY`); past the cap the SLA
pages instead. Filings are capped per buyer and per (buyer, provider) pair, so
no buyer can use up another buyer's allowance.

An upheld refund still pending is paged at `collectable_at + 5 d` and again at
`+ 6 d`: `refundHeld` closes at `+ 7 d`.

## Integration test databases

The migration `1761800000000-payment-intent-dispute-hold` was rewritten in
place before it was pushed. A local integration database that ran its earlier
version records it as applied without the new columns, and the suites with an
explicit migration list then fail on `held_status` / `held_at`. Reset them once:

```sh
DATABASE_PORT=<port> yarn test:integration:reset
```
