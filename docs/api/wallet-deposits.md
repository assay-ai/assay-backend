# Wallet-broadcast deposits with an API credential

An API credential with the opt-in `deposits:write` scope can create a deposit
intent for its own agent and report the transaction its buyer wallet already
broadcast. `deposits:write` is not in the default scope set (new keys and the
first-party MCP grant do not have it) and needs no other scope: funding the
agent's escrow-backed balance spends nothing. Polling the deposit needs
`activity:read`. The credential never signs or sends a wallet transaction: the
buyer still controls the wallet key and pays the network fee.

1. Call `POST /api/v1/deposits` with a positive atomic-unit `amount` string and
   the intended `chainId`. The server derives the buyer, agent, organization and
   settlement asset from the authenticated session and chain configuration.
   An agent holds at most 5 open deposit intents (`CREATED` or `SETTLING`,
   still inside the intent's lifetime); a sixth is refused with
   `409 PAYMENT_DEPOSIT_OPEN_LIMIT`.
2. Check the returned requirements against the intended chain, token, escrow,
   buyer and amount. On EVM, the buyer wallet approves the exact token amount
   to the returned spender if needed, then calls the required
   `depositFor(buyer, amount)` on the escrow **after** the intent was created.
   Do not transfer tokens directly to the escrow contract: that does not credit
   a buyer.
3. Report the `depositFor` transaction through
   `POST /api/v1/deposits/{depositId}/broadcast` with
   `{ "transactionHash": "0x..." }`. The server reads the chain and credits the
   escrow `Deposited` events for this intent's buyer in that transaction
   (summed), when:
   - they total at least the requested amount;
   - the transaction was mined after the buyer's earliest deposit intent that
     never settled (open, expired or failed) in the last 24 hours was created
     (60 s of clock skew allowed). Reporting the hash on a fresh intent after
     the first one expired therefore still works.
   The credit is written as pending (never spendable).
4. Poll `GET /api/v1/deposits/{depositId}`. `SETTLED` means the deposit was
   observed; wait for `finality: CONFIRMED` before treating it as available.
   A deposit becomes spendable only once it is final on chain AND the buyer's
   escrow covers everything the ledger counts for that buyer. Until then it
   stays pending; it is never rejected for that reason. A deposit still
   uncovered after 15 minutes alerts the operators. Only a transaction that is
   no longer on chain (reorg) is rejected.

## Single use

A transaction credits each buyer once, across the whole platform. A batch
transaction that funds two buyers lets each buyer claim only its own events.
Reporting the same hash on the same settled intent is idempotent; reporting a
different hash on a settled intent is `409 PAYMENT_DEPOSIT_ALREADY_SETTLED`
(open a new intent for it). A hash that already credited this buyer through
another deposit is `409 PAYMENT_DEPOSIT_TRANSACTION_ALREADY_CLAIMED`; the
answer does not name the other deposit.

A refused report never reserves the hash: only a successful credit records it.
Someone reporting another buyer's hash is refused and leaves that buyer free to
report it.

## Recovery

Every refusal except expiry leaves the intent `CREATED`, so it can be reported
again until it expires. Never send a second deposit transaction to recover a
lost response; read the intent first.

| Answer | Meaning | What to do |
|---|---|---|
| `201` `SETTLED` | Credited (pending until finality) | Poll `GET /deposits/{id}` |
| `422 PAYMENT_DEPOSIT_TRANSFER_NOT_OBSERVED` | Reported before it was mined, or not visible yet (observed for 20 s) | Report the same hash on the same intent again once it is mined |
| `422 PAYMENT_DEPOSIT_TRANSACTION_CREDITS_NOTHING` | Mined, but credits this buyer nothing (reverted, an `approve`, another buyer) | Report the `depositFor` hash |
| `422 PAYMENT_DEPOSIT_TRANSACTION_PREDATES_INTENT` | Mined before any unsettled intent of this buyer (last 24 hours) existed | Not claimable. Withdraw it from the escrow and deposit again through a new intent |
| `409 PAYMENT_DEPOSIT_INVALID_STATE_TRANSITION` | A report of this intent is in flight (`SETTLING`) | Poll `GET /deposits/{id}`; do not retry. A `SETTLING` intent whose request died is resumed by the platform within minutes |
| `402 PAYMENT_DEPOSIT_EXPIRED` | The intent expired (10 minutes on EVM) | Open a new intent and report the same hash on it (within 24 hours of the first intent) |
| `503 CHAIN_RPC_READ_FAILED` | The chain could not be read | Retry the same hash; nothing was recorded |

## Deposits made outside an intent

A `deposit()` or `depositFor()` sent with no deposit intent of the buyer open
(or expired or failed within the previous 24 hours) stays uncredited (the
reconciler reports it as `escrow_uncredited_deposit`). It cannot be claimed
later, because its money may have been withdrawn since. The buyer withdraws it
from the escrow and deposits again through an intent.

## Scope of access

API credentials may report and read only deposit intents belonging to their
own agent inside their organization. Another agent's intent returns the same
`404 PAYMENT_DEPOSIT_NOT_FOUND` as a missing one ("not this agent's or not in
this organization"). Human sessions keep organization-wide access. Deposit
history listing remains human-only.

`POST /deposits/{depositId}/settle`, which hands a signed transaction to the
facilitator, remains human-only. This API flow does not change account spending
limits, delegate grants, withdrawals, provider stake or credential scopes.

Each create and report by an API credential writes an audit row
(`deposit.intent_created`, `deposit.reported`) naming the credential.
Both routes are rate limited per account and, within it, per credential.
