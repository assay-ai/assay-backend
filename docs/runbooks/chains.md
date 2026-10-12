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
  process that has to send without one fails at its first send.

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
