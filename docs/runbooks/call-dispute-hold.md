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

1. Upgrade X402Escrow and X402Config on that chain (contract work).
2. Add the chain's CAIP-2 id to `EVM_HOLD_LIVE_CHAINS` on the API and the
   scheduler, and restart both.
3. From then on, filings inside the window on that chain are refund-guaranteed.

## The decision SLA

| From filing | What happens |
|---|---|
| 24 h | No provider reply: the provider is marked silent and can no longer reply |
| 48 h | An operator is paged |
| 72 h | Auto-upheld (logged as `S-14` under the system actor) when the refund is guaranteed, the provider stayed silent and the amount is below `CALL_DISPUTE_TWO_PERSON_THRESHOLD`; otherwise paged |
| 6 d | Paged again (also for an upheld refund still pending), before the chain timeout |

## Integration test databases

The migration `1761800000000-payment-intent-dispute-hold` was rewritten in
place before it was pushed. A local integration database that ran its earlier
version records it as applied without the new columns, and the suites with an
explicit migration list then fail on `held_status` / `held_at`. Reset them once:

```sh
DATABASE_PORT=<port> yarn test:integration:reset
```
