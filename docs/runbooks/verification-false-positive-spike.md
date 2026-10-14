# Runbook: Verification false-positive spike

**Signal:** `verification_false_positive_rate_high` (`GoldenSignal.FALSE_POSITIVE_RATE` in
`src/shared/alerting/golden-signals.ts`) — warn > 2%, page > 5%, measured against a **manually
labelled sample** of FAIL verdicts.
**Read this first:** as of this change, **nothing in this codebase produces that number.** There is
no labelled-sample pipeline. `evaluateGoldenSignal(GoldenSignal.FALSE_POSITIVE_RATE, …)` exists and
is tested, but has no caller — see its docstring, which explicitly forbids feeding it a
dispute-derived rate to manufacture one. If you arrived here because a `verification_false_positive_rate_high`
alert actually fired, someone wired a real labelled-sample producer after this was written; if you
arrived here because `GET /operator/health`'s `falsePositiveRate` looks bad, read **§1** carefully —
that field is a different, weaker signal, not this one.

## §1. What you actually have today: the dispute-derived proxy

`PlatformHealthService.falsePositiveRate` (`src/modules/operator/services/platform-health.service.ts`)
computes `falsePositives / resolved` over the trailing 30 days from
`SlashProposalRepository.falsePositiveCounts`, exposed on `GET /operator/health` alongside
`falsePositiveGate` (`= 0.02`, the same 2% bar, just compared against a different denominator). This is a **lagging, self-selected** number — it only counts calls somebody
disputed — not the platform-wide rate. Use it as a smoke signal ("did this jump"), never as the
number that decides step 6 below.

## 1. Identify the policy and version from the verdict distribution

Every judged call is one row in `verification_records`, carrying both the checks that produced the
votes (`policy_id`/`policy_version`) and the policy that turned them into a status
(`decision_policy_id`/`decision_policy_version`). Group by the second pair — it is what
`DecisionPolicyService` operates on:

```sql
SELECT decision_policy_id, decision_policy_version, verdict_status, count(*)
FROM verification_records
WHERE tool_id = '<affected tool uuid>'
  AND created_at > now() - interval '2 hours'
GROUP BY 1, 2, 3
ORDER BY 3, count(*) DESC;
```

A version whose `FAIL` share jumped against its own recent history (or against a sibling version
still running) is your suspect. If you cannot narrow it to one tool/policy yet, treat every active
policy as suspect and use the `GLOBAL` kill scope in step 2 rather than guessing.

## 2. Move the policy to SHADOW — in practice, `withdraw()` to `WITHDRAWN`

The doc says "move to SHADOW"; the actual lifecycle transition is different and it matters which one
you invoke. `DecisionPolicyService.withdraw(policyId, version, reason, actor)`
(`src/modules/verification/services/decision-policy.service.ts`) engages the kill switch **first**
(economic effect stops within its SLA, not on the DB write — see below) and then moves the row from
`ACTIVE` **or** `SHADOW` to `WITHDRAWN`, never back to `SHADOW` directly. There is no `SHADOW → SHADOW`
no-op path because there does not need to be one: the kill switch is what stops enforcement, and it
works identically regardless of the stored lifecycle.

**There is no HTTP endpoint for this today.** `DecisionPolicyService` has no controller. Reaching
`withdraw()` during an incident means either a one-off script run inside the API or scheduler
process (`ts-node -e` against a Nest application context, or a temporary CLI command) or — if you
have not built one yet — that is the gap this incident just found; note it and keep going with the
kill switch directly (next paragraph), which does not require the service method to be reachable.

**The kill switch itself** (`RedisPolicyKillSwitchService`,
`src/modules/verification/services/redis-policy-kill-switch.service.ts`) is durable Redis state,
independent of Postgres, and is what actually stops money moving:

- Hash: `verification:killswitch` (namespace configurable via `VERIFICATION_KILL_SWITCH_NAMESPACE`,
  default shown here).
- Field for one policy version: `policy:<policyId>@<version>`. For every version of one policy:
  `policy:<policyId>`. For everything, everywhere — the panic button, when you could not narrow it
  in step 1 — field `all` (`KillScope.GLOBAL`).
- Change notification: `PUBLISH verification:killswitch:changed <key>` — every process refreshes its
  local snapshot on this pub/sub message (near-instant) and also polls every
  `VERIFICATION_KILL_SWITCH_POLL_MS` (default 2s) as the guaranteed bound. A snapshot older than
  `VERIFICATION_KILL_SWITCH_STALE_MS` (default 30s) is treated as "everything withdrawn" — an
  unreachable Redis fails toward *less* enforcement, not more, so a kill switch action is at worst
  slow, never silently ignored.

You can confirm current state read-only with `redis-cli HGETALL verification:killswitch` — do not
`HSET` directly; that skips the Postgres audit row `withdraw()` also writes and the DB lifecycle
transition, leaving the row saying `ACTIVE` while nothing enforces it.

## 3. Suspend pending slash proposals for affected windows

Real endpoint, this one has a controller: `POST /operator/cases/:proposalId/suspend`
(`OperatorCasesController`, `src/modules/operator/controllers/operator-cases.controller.ts`), roles
`ADJ` / `ADJL` / `SRE`, override code `S-1`. Body:

```json
{ "reasonCode": "verification_false_positive_spike", "note": "<at least 20 characters, what and why>" }
```

Find the affected `proposalId`s first — `slash_proposals` rows opened from `SLA_STRIKE` or a verdict
tied to the suspect policy/version, still in a pending (`PROPOSED`) status, i.e. before
`earliestExecutionAt`.

**A suspension is not finished when the call returns.** A case is proposed on chain about a minute
after the provider is notified, so a suspended case normally has a `Pending` record standing with
the provider's stake reserved. `suspend` sets the case to `CANCELLED` and then asks for the on-chain
cancel the same way an overturn does: `chain_status` goes from `PENDING` to `CANCEL_REQUESTED`.
Nothing is signed by this platform. The cancel still needs the settlement admin's signature, and it
has a deadline — see step 4b. `EXECUTING` cases are refused (`SLASH_INVALID_TRANSITION`).

**Who may suspend alone.** From `PROPOSED`, `DISPUTED` and `UNDER_REVIEW` one operator suspends.
From `AWAITING_SECOND` and `UPHELD` a second person has confirmed the penalty or is confirming it,
so the suspension is two-person: the call answers `202 { approvalId }` and suspends nothing yet. A
second operator holding `ADJ` or `ADJL`, with an authority limit that covers the penalty, approves
it in the Approvals inbox (`POST /operator/approvals/:approvalId/approve`), which suspends it then —
re-checking the case as it is at that moment. See `operator-access.md`.

## 4. Compensate any slash that already executed — check `status`, not the clock

The doc frames this as "still inside the 72h dispute timelock." In this codebase the 72h
(`SLASH_TIMELOCK_HOURS`, default 72, `src/modules/slash/constants/slash.constants.ts`) only delays
**execution** — it sets `earliestExecutionAt = now + 72h` when a proposal is opened
(`slash-proposal.service.ts`). It is not a time bound on putting the money back.
`SlashExecutionService.markCompensated()`
(`src/modules/slash/services/slash-execution.service.ts`) only checks
`proposal.executedAt && proposal.appliedAmount && !proposal.reversedAt` — no elapsed-time guard at
the application layer. So the real branch is:

- **Still pending** (before `earliestExecutionAt`, `status = PROPOSED`) → step 3's `suspend`, then
  get the cancel signed (step 4b). Nothing has moved on chain yet, so there is nothing to give
  back — as long as the admin signs before the record becomes executable.
- **Already `EXECUTED`** → **two calls, and a human with the treasury's keys between them.** Lean
  v3 deleted `reverse_slash`: there is no instruction that moves money back into a provider's
  stake on a verifier's say-so, because every door of that shape can be pushed the other way. What
  replaced it is the plainest thing available — the treasury deposits into the provider's stake
  with `deposit_stake`.

  1. `POST /operator/cases/:proposalId/compensation-intent` (roles `ADJL` / `TRE`, no body).
     Returns `{ transaction, provider, amountMinor, depositor }` — an **unsigned** base64
     transaction whose fee payer and only signer is `Config.treasury`. It writes nothing.
  2. The treasury's signers sign and submit it. This backend holds none of those keys and cannot.
  3. `POST /operator/cases/:proposalId/compensated` with
     `{ "signature": "<base58>", "reasonCode": "...", "note": "..." }`. The signature is
     **verified against the cluster** before anything is written: it must be a confirmed
     `deposit_stake` into *this* provider's stake account for at least what the chain took.
     A signature that shows anything else is refused with `SLASH_COMPENSATION_NOT_CONFIRMED`
     and the case is untouched.

  Step 3 is **two-person** (override code `S-5`): after the deposit is verified the call answers
  `202 { approvalId }`, and a second operator approves it in the Approvals inbox — it must not be
  the requester (`chk_override_log_entries_no_self_approval` refuses it at the database too), it
  must hold `ADJL` or `TRE`, and its own authority limit must cover the amount deposited. The
  deposit is verified again at approval. Step 1 is not two-person — it builds and writes nothing.

  A **fleet sweep** (`POST /operator/cases/:proposalId/sweep`, override code `S-11`) is two-person
  the same way (queued, `202`): its second approver must hold `ADJ` or `ADJL`.

  For every two-person action the approver must be an active operator other than the actor, hold
  one of the row's approver roles, and — when the action has an amount — have an authority limit at
  or above it. Otherwise the request is refused before anything is written:
  `403 OPERATOR_APPROVER_ROLE_REQUIRED` or `403 OPERATOR_APPROVER_AUTHORITY_EXCEEDED`.

## 4b. The standing on-chain record, when nobody has executed it

An overturn or a suspension asks for the on-chain cancel after it commits, which moves the case's
`chain_status` from `PENDING` to `CANCEL_REQUESTED`. (A case with no record on chain yet stays at
`NONE` and needs nothing: a closed case is never proposed.) The record is still `Pending` on chain
with the provider's stake reserved, and the cancel is the **settlement admin's** instruction, so
this platform cannot withdraw it itself.

**The cancel has a deadline.** Executing a record is permissionless once its timelock has passed:
from `chain_executable_at` (shown in the operator console and returned by
`GET /operator/cases/:proposalId` as `chainExecutableAt`) anyone can execute the penalty, whatever
the case says off chain. The settlement admin must sign the cancel before that moment.

- `POST /operator/cases/:proposalId/cancel-intent` (roles `ADJL` / `TRE`) returns
  `{ transaction, admin, requestId, provider }` — an unsigned cancel for the settlement admin's
  key. It writes nothing and is refused unless `chain_status` is `CANCEL_REQUESTED`. The case's
  `chain_status` moves to `CANCELLED` when `SlashLifecycleJob`'s admin-cancel sweep sees the record
  leave `Pending`; the case `status` (`CANCELLED` for a suspension, `OVERTURNED` for an overturn)
  does not change.
- **If the request was lost, it is repaired.** Every tick, `SlashLifecycleJob` looks for cases that
  are `CANCELLED` or `OVERTURNED` while `chain_status` is still `PENDING` — a failed request, or a
  suspension that landed while the proposal was in flight — and requests the cancel for them. It
  logs a warning when it does. Cases the chain itself voided (`resolution_kind =
  AUTO_CHAIN_VOIDED`) are not touched by this.
- **If nobody signs it and nobody executes it,** the reservation is still released: seven days
  after the record became executable (`SLASH_EXECUTION_GRACE_SECONDS`), the same sweep calls the
  permissionless `expire_slash` itself. That is the backstop for the reservation only. It does
  **not** protect the provider during those seven days, when anyone can execute.
- **If somebody executes it first,** the sweep records that as what it is: `chain_status =
  EXECUTED`, `executed_at` and `applied_amount` are written, the case `status` keeps the human
  decision, the timeline gets an `EXECUTED_AFTER_CLOSURE` entry and the log an error line naming the
  case. For an **overturned** case the compensation in step 4 then applies. For a **suspended**
  case, `compensation-intent` builds the deposit but `compensated` is refused today
  (`SLASH_INVALID_TRANSITION`: there is no `CANCELLED → REVERSED` transition) — escalate it.

## 5. Label a sample manually, measure the true false-positive rate

No tooling for this exists in the codebase. Pull the suspect calls' `request`/`response`/`verdict_status`
from `verification_records` for the affected `decision_policy_id`/`decision_policy_version` and
label by hand (spreadsheet, ticket, whatever your process is) — this is the evidence
`PromotionEvidence` (step 6) will eventually need anyway.

## 6. Fix, re-shadow, promote only below 2%

A withdrawn policy comes back through `DecisionPolicyService.reinstate(policyId, version, actor)` —
into `SHADOW`, **never straight to `ACTIVE`**; it has to re-earn enforcement through the gate exactly
like a brand-new policy, on purpose (`reinstate`'s own docstring: "the reinstatement of a policy
somebody withdrew during an incident is precisely the moment a shortcut looks reasonable and is
not"). Promotion is `DecisionPolicyService.promote(policyId, version, evidence: PromotionEvidence)`
against `PROMOTION_GATE` (`src/modules/verification/domain/lifecycle/promotion.ts`):

- `shadowCalls >= 500`
- `labelledSamples >= 100`
- `falsePositives / labelledSamples < 0.02` — strict, not `<=`
- `requestedBy !== approvedBy`

All four are enforced by a CHECK constraint on the table underneath the service, not just the
TypeScript — a hand-typed `UPDATE ... SET lifecycle = 'ACTIVE'` cannot route around the gate.
