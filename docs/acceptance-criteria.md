# Acceptance criteria, per chain

These criteria define when a chain integration counts as done. Each of them is a run, not an
opinion. `yarn testnet:acceptance` (`scripts/testnet/acceptance-suite.ts`) has one step per
bullet, and `scripts/testnet/lib/k3-criteria.ts` holds the same list as data.
`test/unit/acceptance/k3-coverage.spec.ts` reads this file and fails if the two disagree in count,
order or text, or if a criterion has no step registered against it.

The first line of each bullet is compared verbatim, so edit this file and `k3-criteria.ts`
together.

## Criteria

**Solana (regression):**
- `devnet:acceptance` passes unchanged.
- Every existing test green; no test deleted to accommodate the union.
- The contract suite passes with the Solana adapter.
- `ENABLED_CHAINS` listing only mainnet: a devnet deposit is refused with `CHAIN_UNSUPPORTED`,
  no 402 advertises devnet, and `GET /chains` returns mainnet alone.

**Robinhood Chain testnet 46630:**
- Foundry suite: parity with the ~240 Anchor tests that have a behavioural analogue, plus
  invariant tests for the three accounting identities (`escrow.balance` conservation,
  `total_staked == deposited − withdrawn − slashed`, `vault >= total_staked`).
- A buyer funds USDG, sets limits, signs an EIP-712 voucher, the platform redeems it, and the
  provider's USDG balance increases by `amount − fee` in one transaction.
- A voucher whose `(payer, seq)` was already redeemed reverts, in any order (D-23). A voucher malleated to high-s reverts. A voucher with
  mainnet's `chainId` in its domain reverts on testnet.
- A full two-phase slash: propose → 72 h (warped) → execute, and a second run where
  `revokeVerifier` in the window makes `executeSlash` revert and `expireSlash` release.
- A buyer withdraws with **zero** ETH after the relayer's bounded gas top-up.
- The reconciler reports a clean run against a live 46630 deployment.
- `ENABLED_CHAINS` without `eip155:46630`: no 402 advertises it, its providers are excluded, a
  deposit is refused with `CHAIN_UNSUPPORTED`, and `GET /chains` does not list it.
- **The negative test for chain isolation**: a buyer funded only on Solana calling a tool whose only
  provider is on 46630 receives `PAYMENT_NO_SETTLEABLE_CHAIN` — and no transaction, of any kind,
  is submitted to either chain.

**Robinhood Chain mainnet 4663:** all of the above, plus a completed third-party audit with no
unresolved high or critical findings, plus verified source on the chain's block explorer matching
the audited commit.

## End of criteria
