# Runbook: `ENABLED_CHAINS`

**What it decides:** which networks this deployment offers. Nothing else in the process
decides it, and nothing derives it — every module that serves a chain reads this one list.

`src/modules/chains/enabled-chains.ts` points here by name, from its own docstring and from the
error message an operator sees when the variable is wrong. This page is that reference.

## The four ids, to copy from

```
solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp    Solana mainnet-beta
solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1    Solana devnet
eip155:4663                                Robinhood Chain mainnet
eip155:46630                               Robinhood Chain testnet
```

Comma-separated, CAIP-2 literals, **no aliases**. `devnet`, `mainnet` and `mainnet-beta` used to be
accepted and are not any more: with a second namespace present, `mainnet` is ambiguous between
`solana:5eykt4Us…` and `eip155:4663`, and an ambiguous alias in the one variable that decides which
network is live is the mainnet/devnet mislabel the variable exists to prevent.

```
ENABLED_CHAINS=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1,eip155:46630
```

**`eip155:4663` cannot be enabled today, and the refusal is deliberate.** The mainnet USDG address is
unmeasured — `cast code` at the testnet address on 4663 returns `0x` — so the asset registry has no
mainnet row and `assertChainMetadata` refuses the chain at boot. Do not invent an address to get
past it; the measurement is recorded in `docs/chain-facts.md` in the assay-evm repository.

## Unset is a boot failure. There is no default

The old `DEFAULT_SOLANA_ENABLED_CHAINS` ("mainnet and devnet") is gone. A default here is a default
that silently enables a *mainnet* nobody asked for. The house rule this follows: operational dials
fall back so a typo does not stop the process, but a value that silently changes what is live fails
loudly at boot, where somebody is looking.

## `SOLANA_ENABLED_CHAINS` present at all is also a boot failure

Boot fails if the old variable is set — **even beside a valid `ENABLED_CHAINS`**, and even when it is
set to the empty string. Blanking a value is how an operator neutralises a configuration key without
deleting it, so it is the shape most likely to be left behind by a half-finished migration; reading
it as "not set" would be this guard failing open on the one input it exists to catch.

The error message contains the translated replacement line, ready to paste.

**Consequence for a deploy:** the code change and the configuration change must land in the same window.
A deployment still carrying `SOLANA_ENABLED_CHAINS` will refuse to start the moment the new image rolls
out.

## What else must cover every enabled `eip155` chain

Both of these are boot failures if an enabled eip155 chain is missing from them, and both are
no-ops when no eip155 chain is enabled:

- `EVM_RPC_URLS` — `{"eip155:46630":"https://…"}`. `https` only; there is no WebSocket transport.
- `EVM_RELAYER_FLOAT_LOW_WEI`, `EVM_RELAYER_FLOAT_CRITICAL_WEI`, `EVM_RELAYER_GAS_GRANT_MAX_WEI`
  and `EVM_RELAYER_GAS_GRANT_DAILY_MAX_WEI` — the float floor and the grant's two caps. **No
  defaults; unset is a boot failure**, because an unwatched float is worse than a process that
  refuses to start. `EVM_RELAYER_FLOAT_LOW_WEI` is **one** number read by two things — the grant
  refuses below it (`GasGrantRefusal.RELAYER_FLOAT_LOW`) and `EvmRelayerFloatMonitor` alerts on it
  — and it was previously called `EVM_RELAYER_FLOAT_LOW_WATER_WEI`. `EVM_RELAYER_FLOAT_CRITICAL_WEI`
  must be strictly below it. What an operator does when the float runs dry is in the assay-evm repository's deploy runbook.
- `EVM_DEPLOYMENTS` — seven addresses per chain: `config`, `stake`, `escrow`, `asset`,
  `escrowImplementation`, `admin`, `owner`. The last three are what `VaultPort.assertVaultControl`
  compares the live chain against, and they are the ones that **move**: `escrowImplementation` on
  every upgrade, `owner` (`X402Config.owner()`, the upgrade authority of all three contracts) on
  every ownership transfer, `admin` (the operational key the owner appoints, not the upgrade
  authority) on every appointment. Copy them from `deployments/<chainId>.json` in the assay-evm
  repository. A change that does not update this variable stops the reconciler on its next pass —
  which is the correct behaviour for a change nobody recorded.
- `EVM_RELAYER_KEYS` and `EVM_REDEEMER_KEYS` — one `{ chainId, secretKey }` per chain each, read
  once and deleted from the environment. The **redeemer** key is the address in
  `Config.params().redeemer` and sends only `redeemVoucher[Batch]`; the **relayer** key has no
  on-chain role and sends relayed buyer requests, the withdraw gas grant and slash calls. They must be
  different keys: the boot refuses a chain where they are equal. Neither is required at boot; a
  process that has to send without one fails at its first send. The vault-control check
  (`assertVaultControl`, run first by every reconciler pass) also reads the live
  `params().redeemer` and fails closed (`CHAIN_VAULT_CONTROL_UNVERIFIED`) unless the
  `EVM_REDEEMER_KEYS` address equals it and the `EVM_RELAYER_KEYS` address does not. When rotating,
  either `updateConfig` the redeemer to the new redeemer key's address, or move the key that is
  already `params().redeemer` into `EVM_REDEEMER_KEYS` and give the relayer a new key (assay-evm
  runbook §7.4). The same check logs a WARN while `pendingOwner()` is non-zero.

## What `ENABLED_CHAINS` also decides, and is easy to forget

- **The reconciler's work list.** `ReconciliationJob` reconciles the registered settlement asset of
  every enabled chain, one pass per chain, never a sum.
- **`/reserves`.** The public proof-of-reserves page publishes one panel per enabled chain, from the
  same derivation (`settlementAssetsOn`). Adding a chain to `ENABLED_CHAINS` publishes it; there is
  no second list to update. `PUBLIC_RESERVES_ASSET` still decides whether the route exists at all.
- **Absence everywhere.** A chain not in the list has no adapter, no vault, no stake reader and no
  panel. That is the rule: absent from the list means absent from the process, not merely
  hidden.

## **`ENABLED_CHAINS` IS NOT A KILL SWITCH**

Removing a chain from the list on a running deployment does not stop the chain. It stops **this
platform from serving it**: quotes, deposits, redemptions and reconciliation all disappear, and the
money stays exactly where it is with nobody watching it. Buyers on EVM can still call `withdraw()`
directly, vouchers already signed stay redeemable by anyone holding them, and no reconciliation pass
will notice if the vault goes short.

**Stopping a live chain is `setPaused` on chain, from the admin hardware wallet, on both chains
alike.** That is a human action with a hardware wallet, not
an environment variable, and it is the only thing that actually stops money moving.

Take a chain out of `ENABLED_CHAINS` when this deployment should no longer offer it — a decommission,
a split of traffic between deployments. Pause on chain when something is wrong.

## A slash record this platform did not plan

**Alerts:** `slash_proposal_unknown` and `slash_proposal_mismatch` (CRITICAL), from
`EvmSlashProposalWatcher` in the scheduler. Every two minutes it reads `SlashProposed` events from the
stake contract of each enabled `eip155` chain (at most 10,000 blocks per pass, from a cursor kept in
Redis) and compares each record with `slash_proposal_parts`:

- `slash_proposal_unknown`: no part has this `chain_request_id`. The backend writes a part before it
  signs anything, so the record was signed outside this backend's planner.
- `slash_proposal_mismatch`: a part exists, but the record's beneficiary or penalty differs from it.

`slash_watch_unreadable` (WARN) means the events could not be read, so nothing is being watched on
that chain until it clears. The watcher only reads; it never signs or sends.

**Treat either CRITICAL alert as a compromised verifier key or a compromised database.** A valid
attestation is all `proposeSlash` checks, and the record can name any beneficiary.

**The window is 72 hours.** Nothing moves at `proposeSlash`. Anyone can call `executeSlash` once the
record's `executableAt` (in the alert details) has passed, 72 hours after the proposal, and then up to
`slashCapBps` of the provider's stake per day moves, 60% of it to the named beneficiary. Act before
`executableAt`; do not wait for business hours.

Response, from the admin hardware wallet (the backend holds no admin key):

1. **`X402Config.revokeVerifier(<verifier>)`** with the `verifier` from the alert. Execution re-checks
   the key, so this voids every pending record that key signed, including any not yet alerted, and
   stops new ones. Afterwards anyone can call `expireSlash(requestId)` to release the reservations.
2. If the scope is unclear, or more than one key is involved: **`X402Config.setPaused(true)`**. It
   blocks `proposeSlash` and `executeSlash` (and deposits and redemptions; buyers can still withdraw).
3. For a single record when the key itself is still trusted (for example a mismatch traced to a
   database edit): **`X402Stake.cancelSlash(<requestId>)`**.

Then: register a fresh verifier key (`yarn verifier:registry`), rotate the database and server
credentials if the cause is not yet known, check the stored parts of every open case against the
chain before unpausing, and write up the incident. A record the platform did plan never raises these
alerts, so a false positive points at a bug in the watcher or in the part rows, not at noise.

## The EVM dispute upgrade (assay-evm D-19)

**The backend assumes the upgraded contracts; upgrade the chain before deploying it.** There is no
old-versus-new detection. At boot every process logs one error, `contracts not upgraded`, for a
chain whose `X402Config` does not answer `arbiter()`; disputes, rulings, the on-chain blocklist
and the slash delay will not work there. The live `slashDelaySeconds()` is read for every proposal
pass; a failed read is an RPC error and the case waits for the next tick (no delay is ever
assumed). The arbiter must be appointed: every cancel and ruling is built for the arbiter, and
`CHAIN_ARBITER_NOT_SET` is returned while it is `address(0)`.

- **Pause and blocklist cache.** `EvmChainStateIndexer` (scheduler, every
  minute) indexes `PauseToggled` / `BlockedSet` into `evm_chain_states` and
  `evm_blocked_addresses`, and every `EVM_CHAIN_STATE_RECONCILE_MS` re-reads
  `paused()` and `blocked()` live. `GET /operator/health` → `chainState[]`
  shows each chain's flag, blocked count and `lagSeconds`; `stale: true` (more
  than `EVM_CHAIN_STATE_MAX_LAG_MS` behind) also logs a WARN and raises
  `evm_chain_state_lagging`. A stale cache never refuses on its own: every
  refusal is confirmed with a live read.
  - **Confirmations.** The index stops `EVM_CHAIN_STATE_CONFIRMATIONS` blocks
    (default 12) behind the head, so a reorged-out event is never written and a
    reorged-in one is not skipped. `lagSeconds` therefore never reaches 0.
  - **Where a new chain starts.** With no cursor yet, the indexer starts at
    `EVM_CHAIN_STATE_FROM_BLOCK` (JSON, `{"eip155:46630": <block>}`), else at
    the deployment's recorded `disputeUpgradeBlock`. With neither, it reads
    `blocked()` live for every address the platform knows on that chain
    (buyers' escrows, providers' payout and stake-authority accounts, agent
    credentials' delegates), writes the blocked ones, starts at the safe head
    and raises WARN `evm_chain_state_unknown_start`. An address the platform
    has never seen is then only learned from a later `BlockedSet`, so set
    `EVM_CHAIN_STATE_FROM_BLOCK` to the dispute upgrade's block when you know
    it. The reconcile re-checks only addresses already in the table.
- **CRITICAL `evm_config_lever_pulled`** on `AdminSet`, `ConfigUpdated`
  (treasury, redeemer, bps, caps, minimum stake), `VerifierRevokedEvent`,
  `ArbiterSet`, `SlashDelaySet` or `VerifierRegistered`: confirm with the admin
  that it was intended; if not, treat the admin key as stolen (owner
  `setAdmin`, then revoke). A new treasury redirects 30% of every slash.
  **CRITICAL `evm_proxy_upgraded`** on an ERC-1967 `Upgraded` of the Config,
  Stake or Escrow proxy: only the owner key can do this; confirm it, and record
  the new implementation (`escrowImplementation`).
  **WARN `evm_config_pause_toggled`** on `PauseToggled`, and
  **WARN `evm_admin_unblocked_address`** on `BlockedSet(false)` (only the admin
  can unblock — the dangerous direction): confirm with the admin.
  **WARN `evm_arbiter_blocked_address`**: the arbiter blocked an address;
  confirm with the arbiter.
- **Disputes.** A provider's `disputeSlash` shows on the case as
  `chainStatus: DISPUTED` and moves a `PROPOSED` case into review. The arbiter
  rules from the operator console's arbiter page (`/operator/arbiter/*`): the
  backend builds the unsigned `upholdSlashBatch` / `cancelSlashBatch` /
  `setBlocked`, the arbiter's wallet signs. An unruled dispute is expired by
  the backend at `disputedAt + 30 d`.
  - A dispute freezes only the part it names: the case's other parts keep
    executing (`chainStatus` stays `PENDING`, `chainDisputedParts` counts the
    disputed ones; `DISPUTED` means every live part is disputed).
  - A block intent for one of the platform's own addresses (treasury, redeemer,
    a verifier key, admin, owner, arbiter, the three contracts) is refused with
    `422 CHAIN_PLATFORM_ADDRESS_NOT_BLOCKABLE`; each is read live.
  - An arbiter's `cancelSlash(Batch)` (`SlashCancelled`) is mirrored at once:
    the part is `CANCELLED`, and the case closes as soon as nothing of it
    stands and nothing executed.
- **WARN `evm_verifier_key_expiring`** (hourly): a verifier key that still has
  open (`Pending` or `Disputed`) slash records expires within 45 days, or
  already has. Records signed by an expired key can never execute, so rotate:
  register a NEW key (`yarn verifier:registry`; an address is one-shot), switch
  signing to it, and let the old key's records run out or be re-proposed.
- **On the upgrade itself**, update `EVM_DEPLOYMENTS[...].escrowImplementation`
  in the same change: the vault-control check stops the reconciler on an
  implementation nobody recorded.
