# Operator access: wallet sign-in, the directory, and two-person approvals

Operators sign in to the console with an EVM wallet (MetaMask, a hardware wallet, or the Privy
embedded wallet). There is no credentials file and no long-lived operator secret. The second
person of a two-person action approves it with their own sign-in, from a queue.

All paths below are under `/api/v1`. Every operator route except sign-in takes
`Authorization: Bearer <session token>`.

## 1. Sign in

1. `POST /operator/auth/challenge` `{ "address": "0x…" }` → `{ message, nonce, expiresAt }`.
2. The wallet signs `message` exactly as returned, with `personal_sign`.
3. `POST /operator/auth/verify` `{ "message": "…", "signature": "0x…" }` →
   `{ token, expiresAt, operator }`. `token` is the session, valid for `OPERATOR_SESSION_TTL_HOURS`
   (default 8).
4. `POST /operator/auth/logout` with the bearer token revokes it (`204`).

The message is EIP-4361 (Sign-In with Ethereum):

```
<OPERATOR_SIGN_IN_DOMAIN> wants you to sign in with your Ethereum account:
<EIP-55 address>

Sign in to the Assay operator console

URI: <OPERATOR_SIGN_IN_URI>
Version: 1
Chain ID: <OPERATOR_SIGN_IN_CHAIN_ID, default 46630>
Nonce: <nonce>
Issued At: <ISO 8601>
Expiration Time: <Issued At + 5 minutes>
```

The nonce is single-use (kept in Redis for five minutes, removed on the first verify attempt), and
the verify refuses a message that is not byte-for-byte the one issued, names another domain, URI
or chain, or has expired. Only EOA signatures are accepted; smart-contract wallets (ERC-1271 /
ERC-6492) are not supported.

| Answer | Meaning |
|---|---|
| `401 OPERATOR_CREDENTIAL_INVALID` | bad, expired, replayed or foreign message or signature; or a missing, expired or revoked session |
| `403 OPERATOR_NOT_AUTHORIZED` | the wallet signed correctly but is not an `ACTIVE` operator (unknown, suspended or removed) |
| `429 OPERATOR_AUTH_RATE_LIMITED` | 10 failures within 5 minutes from this client address, or for this wallet |

**Revocation is immediate.** Every request re-reads the operator row (cached for at most 5 seconds
per API instance). Removing an operator in the console also revokes every session they hold, on
every instance at once.

Configuration: `OPERATOR_SIGN_IN_DOMAIN` and `OPERATOR_SIGN_IN_URI` are required (unset refuses
every sign-in); see `.env.example`.

## 2. The first operator (bootstrap)

The CLI needs only database access:

```sh
yarn operator:add --wallet 0x… --subject alice@ --roles OPS_ADMIN,ADJL [--limit 0|<minor units>|unbounded] \
  [--display-name "Alice"] [--email alice@example.com]
yarn operator:list
yarn operator:remove --wallet 0x… | --subject alice@ | --id <uuid>
```

- `--limit` defaults to `0`. `unbounded` stores `NULL`.
- `--subject` naming an existing row that has no wallet (one provisioned before wallet sign-in)
  links the wallet to it. A removed operator's wallet is restored on the same row.
- A CLI change writes no override-log entry (there is no operator to attribute it to). Add at
  least **two** `OPS_ADMIN` operators, so that the console can take over: adding an operator there
  needs a second `OPS_ADMIN`.

## 3. Managing operators in the console (`OPS_ADMIN`)

`OPS_ADMIN` is the one role that manages the directory; no other role grants it.

| Route | Register | Approval |
|---|---|---|
| `GET /operator/operators[?status=]` | — | any operator may read |
| `POST /operator/operators` | `A-12` | always two-person: `202 { approvalId }` |
| `PATCH /operator/operators/:id` | `A-13` | lowering roles or the limit: applied at once (`200`); adding a role or raising the limit: `202 { approvalId }` |
| `POST /operator/operators/:id/remove` | `A-14` | single-person, at once (`200`) |

Nobody may change or remove their own row, and an approver may not approve a change to their own
row (`403 OPERATOR_SELF_CHANGE_REFUSED`).

## 4. Two-person actions: the approvals queue

A two-person route called by one operator answers **`202 { approvalId, status: "PENDING", action,
expiresAt }`** and does nothing else. The routes:

| Route | Register | Second person must hold |
|---|---|---|
| `POST /operator/cases/:id/suspend` from `AWAITING_SECOND` / `UPHELD` | `S-1` | `ADJ` or `ADJL`, limit ≥ penalty |
| `POST /operator/cases/:id/sweep` | `S-11` | `ADJ` or `ADJL`, limit ≥ swept penalties |
| `POST /operator/cases/:id/compensated` | `S-5` | `ADJL` or `TRE`, limit ≥ deposit |
| `POST /operator/blocks/:id/unblock` | `A-10` | `ADJL` |
| `POST /operator/operators` | `A-12` | `OPS_ADMIN` |
| `PATCH /operator/operators/:id` (raising) | `A-13` | `OPS_ADMIN` |

Everything the action checks before it would write (the requester's role and limit, the target's
state, a compensation deposit on chain) is checked when it is queued, so a request that could never
succeed is refused at once.

- `GET /operator/approvals?status=PENDING` — the inbox (any operator).
- `GET /operator/approvals/:id` — one entry.
- `POST /operator/approvals/:id/approve` — by a **different** operator. Re-runs the original action
  with the stored request, as the requester, on the state as it is now; the register entry names
  both people. Answers `{ approval, result }`, where `result` is what the route itself would have
  answered.
- `POST /operator/approvals/:id/reject` — by anyone who could approve it, or by the requester (to
  withdraw it).

Approvals expire after 24 hours. A failed approval (the case moved on, the approver's role or
limit is short, the requester was removed) leaves it `PENDING`, to be retried, rejected, or left to
expire. Two approvers at the same moment produce one execution.

| Answer | Meaning |
|---|---|
| `409 OPERATOR_SELF_APPROVAL_REFUSED` | the requester tried to approve their own request |
| `403 OPERATOR_APPROVER_ROLE_REQUIRED` / `403 OPERATOR_APPROVER_AUTHORITY_EXCEEDED` | the approver's role or limit does not cover this action |
| `409 OPERATOR_APPROVAL_NOT_PENDING` | already approved, rejected or expired |
| `404 OPERATOR_APPROVAL_NOT_FOUND` | no such approval |
| `403 OPERATOR_NOT_AUTHORIZED` | the requester is no longer an active operator |

The `X-Operator-Approver` header is gone: nothing reads it.
