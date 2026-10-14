# Runbook: Blocking an account

**Use when:** a buyer's or provider's key has leaked, or an account must stop doing anything on the
platform now (fraud, legal hold). This is the off-chain blocklist. The on-chain blacklist in the
contracts is separate. A leaked key that holds funds on chain needs both.

## 1. Block

`POST /operator/blocks`, override code **`A-9`**, roles **`ADJL`** or **`SRE`**, single person:

```json
{
  "subjectKind": "WALLET",
  "subject": "eip155:84532:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45",
  "reasonCode": "LEAKED_KEY",
  "note": "<at least 20 characters: what happened, who reported it>",
  "ticketRef": "INC-123"
}
```

- `subjectKind: "ORGANIZATION"` takes the tenant's uuid. Everything the tenant does stops: its
  dashboard sessions, its agents' machine credentials and, for a provider, its bindings.
- `subjectKind: "WALLET"` takes a CAIP-10 account. It is blocked on **every chain of its
  namespace** (`eip155:8453:0xabc` also blocks `eip155:84532:0xabc`), because a leaked key signs
  everywhere. EVM addresses are matched case-insensitively.
- One standing block per subject: a second one is `409 OPERATOR_BLOCK_ALREADY_ACTIVE`, naming the
  existing block.
- The note is internal. The account holder sees the `reasonCode` and the date, never the note.

The block takes effect on the instance that handled the request immediately, and on every other
instance within milliseconds (Redis pub/sub on `ACCOUNT_BLOCKLIST_CHANNEL`). If the announcement is
lost, every instance re-reads `account_blocks` every `ACCOUNT_BLOCKLIST_POLL_MS` (default 5 s), so
that is the worst case. Postgres is the source of truth. Do not insert rows by hand: a row written
without its `A-9` register entry is an intervention nobody can audit.

## 2. What a block refuses

| Where | Refused | Code |
| --- | --- | --- |
| Agent machine credential (`x402_sk_live_…`) | everything | `AUTH_ORGANIZATION_SUSPENDED` (org) / `ACCOUNT_BLOCKED` (wallet) |
| Dashboard session (Privy, or a config-file token) | every non-`GET` route; `GET`s stay open | same |
| `POST /mcp` (tools/list, tools/call), public demo | everything | same |
| New payment intent (every rail) | payer org, payer account, provider org, payout account, voucher delegate | `ACCOUNT_BLOCKED` |
| Voucher accepted on a call | payer, `payTo`, provider account (checked after the signature and the session binding, so it is not an oracle) | `ACCOUNT_BLOCKED` |
| Voucher seq (`GET /escrow/next-seq`, rail B `PAYMENT_REQUIRED`) | payer org or account | `ACCOUNT_BLOCKED` |
| Voucher redemption worker | any party blocked (platform or on-chain blocklist): left out of the queue, hold kept; see below | (one log line per payer) |
| Routing (`tools/call`, `tools/list`, catalogue quotes) | blocked provider reads as `SUSPENDED`; blocked payout wallet drops that chain | existing routing refusals |
| Catalogue (`/catalogue/providers`, `/catalogue/tools`) | blocked provider's bindings are hidden | — |
| Stake intents, stake-authority proof | blocked stake authority | `ACCOUNT_BLOCKED` |
| Payout-address proof | blocked wallet | `ACCOUNT_BLOCKED` |

**A held voucher does not survive a long block.** The redemption queue leaves every voucher with a
blocked party (and the same payer's later vouchers) out of its query, so a blocked party never
delays anyone else's redemption. The chain refuses a voucher `REDEEM_GRACE_SECONDS` (30 min) after
its expiry, about 35 minutes after the call. **By owner decision, a voucher still held past that
point is absorbed by the platform**: after the unblock the next pass meets `VoucherExpired`, the
platform pays the provider out of its own funds (`PROVIDER_CREDIT` with
`chainTxRef = platform_absorbed:VoucherExpired`, CRITICAL alert `voucher_unredeemable`) and the
buyer's hold is released, so the buyer is not charged. A block shorter than ~35 minutes resumes
normally.

**Read-only access stays open for people, by decision.** A blocked person can still sign in and
read the account's own data, so they can see that, and why, they are blocked. `GET
/account/block-status` returns the blocks that apply to the session. Machine credentials get no
access at all, because the machine credential may be the thing that leaked.
The rule is by method, with a short list of reviewed exceptions that a blocked person can still
`POST`/`DELETE`:

- `POST /providers/me/slash-requests/lookup` (read-only: matches on-chain penalties to cases);
- `POST /providers/me/slash-requests/dispute-intent` (builds the provider's own `disputeSlashBatch`;
  the contract lets a blocked provider dispute);
- `POST /escrow/delegates/revoke-intent` and `POST /escrow/delegates/revoke` (revoke an escrow
  delegate; the contract never gates revoking);
- `DELETE /agents/:agentId/credentials/:id` (revoke an agent credential).

The revokes only take authority away, so a leaked delegate or credential can be cut off while the
block stands and does not come back on unblock. Authorizing a delegate and creating a credential
stay refused. The one `GET` that hands out something spendable (`GET /escrow/next-seq`) refuses on
its own. The dashboard mirrors this list (`READ_ONLY_POSTS` in `assay-frontend`).

**Not covered here:** the stand-alone x402 facilitator process (`/verify`, `/settle`) has no
database and does not read the blocklist. `POST /auth/wallet/link` (linking the Privy wallet at sign-in) is not
refused: it moves nothing, and every request after it carries the block. Withdrawals already requested before the block, and
anything on chain, are for the on-chain blacklist.

## 3. Lift

`POST /operator/blocks/:id/unblock`, override code **`A-10`**, roles `ADJL` or `SRE`, **two
person**: the call answers `202 { approvalId }` and lifts nothing yet; a second operator holding
**`ADJL`** approves it with their own sign-in in the console's Approvals inbox
(`POST /operator/approvals/:approvalId/approve`). See `operator-access.md`.

```json
{ "reasonCode": "KEY_ROTATED", "note": "<at least 20 characters>" }
```

Lifting is the dangerous direction (it re-enables whatever the key can spend), so it needs the
second identity and blocking does not. The row stays as the record; a later block of the same
subject is a new row.

## 4. Look

`GET /operator/blocks?subject=…&subjectKind=…&active=true&reasonCode=…` (any operator), newest
first. A wallet `subject` filter matches the same way enforcement does, on any chain of its
namespace. Every block and lifting is also in `GET /operator/override-log?targetType=account_block`.
