# Runbook: Facilitator down

**What "the facilitator" means here:** the x402 SVM facilitator (`/verify`, `/settle`, `/supported`),
either self-hosted by this platform (`SERVICE_TYPE=facilitator` process) or a third-party
one — the API process talks to whichever `FACILITATOR_URL` names through one adapter,
`HttpFacilitatorAdapter` (`src/modules/chains/facilitator/http-facilitator.adapter.ts`), behind the
`FacilitatorPort` interface.

## 1. Confirm the hot path is unaffected

This is checkable, not just assumed: `FACILITATOR_PORT` (the DI token for `FacilitatorPort`) has
**exactly one consumer in this codebase** —
`src/modules/payment/services/deposit.service.ts`. Nothing on the tool-call path — routing,
verification, settlement of an already-funded balance — injects it. Concretely:

- **Tool calls keep working.** A call debits an *existing* ledger balance (a hold against
  `account_balances`); it never reaches the facilitator. Agents with funds keep transacting.
- **New deposits stop.** `DepositService` calls `facilitator.verify()` then `facilitator.settle()`
  to turn an x402 payment payload into a confirmed on-chain deposit. This is the only thing actually
  down.
- **Withdrawals and provider payouts are a separate path entirely** — the buyer's own escrow and
  `VaultPort`, not `FacilitatorPort`. A facilitator outage does not touch them; an
  RPC outage or a Squads issue would, but that is a different incident.

So "confirm the hot path is unaffected" is, in this codebase, a one-line grep away from
being either true or a red flag: `grep -rn FACILITATOR_PORT src/modules --include='*.service.ts'`
should return only `deposit.service.ts`. If it returns anything else, something changed since this
was written and the blast radius is bigger than this runbook assumes.

## 2. Confirm it's actually the facilitator, not something upstream

`GET {FACILITATOR_URL}/supported` (`FACILITATOR_ROUTES.SUPPORTED`,
`src/modules/chains/facilitator/facilitator.wire.ts`) is the cheapest live check — no signing, no
chain write, and it's what `HttpFacilitatorAdapter` itself calls to discover accepted networks. `FACILITATOR_URL`
defaults to `http://127.0.0.1:3100` (read once at boot in `src/modules/chains/chains.module.ts` —
**not hot-reloaded**; a config change needs a restart of every process that imports `ChainsModule`,
in practice the API process).

```bash
curl -sS -m 5 "${FACILITATOR_URL:-http://127.0.0.1:3100}/supported"
```

No response, connection refused, or a 5xx here is "the facilitator is down" as this runbook means
it. Note what happens on this failure at the code level, so a deposit incident doesn't get
misdiagnosed as a payload/signature bug: `HttpFacilitatorAdapter`'s internal `post()` helper
(`http-facilitator.adapter.ts`) **catches every transport failure** and returns `null` rather than
throwing — `verify()`/`settle()` then return `{ isValid: false, invalidReason: UNEXPECTED_SETTLE_ERROR }`
/ `{ success: false, errorReason: UNEXPECTED_SETTLE_ERROR }`, and `DepositService` turns that into a
`throwForX402InvalidReason('UNEXPECTED_SETTLE_ERROR')` domain error. Every failing deposit during
this incident carries that one reason code — if you're seeing a mix of reasons, some deposits are
failing for a different cause and step 2 needs repeating per case.

## 3. Fail over to the configured third-party facilitator

**There is no automatic failover in this codebase.** `FACILITATOR_PORT` resolves to exactly one
`HttpFacilitatorAdapter` bound to exactly one `FACILITATOR_URL` — no secondary URL, no circuit
breaker, no health-based routing. "Fail over" is a manual, three-step action:

1. Have a third-party x402-compatible facilitator endpoint ready (base URL, and it answers `/verify`
   `/settle` `/supported` — confirm with step 2's `curl` against the *new* URL before cutting over).
2. Set `FACILITATOR_URL=<that endpoint>` in the environment of every process that imports
   `ChainsModule` (the API process today).
3. Restart it. There is no signal handler or config-watcher that picks this up live.

If the self-hosted facilitator process itself is up but its fee-payer signer (Kora) is what's
actually broken, there is a break-glass lever inside that process rather than a full failover:
`FEE_PAYER_SIGNER` (default `kora`, pointed at `KORA_RPC_URL`, default `http://127.0.0.1:8080`) can
be set to `FEE_PAYER_SIGNER=local` with `LOCAL_FEE_PAYER_KEYPAIR_PATH` pointed at a raw keypair file
(`src/modules/chains/facilitator/facilitator.module.ts`, `LocalKeypairFeePayerSigner`). Treat this as
last-resort, not a first move: it bypasses whatever policy enforcement Kora itself provides, and it
puts a raw key in the facilitator process. `LocalKeypairFeePayerSigner` also **refuses to start at all when
`NODE_ENV=production`** (throws in its constructor) — this lever does not exist as an option in a
real production deployment; it is a devnet/staging-only escape hatch.

## 4. Deposits and payouts queue; agents with balances keep working

Payouts are unaffected by this incident specifically (see step 1 — they never touch the facilitator).
Deposits fail closed with `UNEXPECTED_SETTLE_ERROR` per step 2 rather than hanging or silently
succeeding; an agent retrying a deposit during the outage gets a clean, typed failure, not a stuck
state. There is currently no deposit retry queue in this codebase — a failed deposit is a failed
attempt the caller (frontend/agent) has to resubmit once the facilitator is back, not something the
backend replays on its own.

## 5. Communicate: "deposits delayed", not "platform down"

Precise in this codebase specifically because of step 1: everyone who already has a balance keeps
transacting through the entire incident. The only affected population is agents trying to fund a
*new* balance during the window.
