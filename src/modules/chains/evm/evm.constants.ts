import { VOUCHER_MAX_SEQ_GAP } from '@modules/payment/constants/escrow-seq.constants';

import { ChainId } from '../ports/caip.types';

/**
 * Constants copied out of assay-evm's `src/Constants.sol`.
 *
 * They are `internal` there, which means they are **not readable over the ABI**
 * — there is no generated getter to call and no way for this file to derive
 * them at runtime. So they are hard-coded, and
 * `test/unit/chains/evm/constants-pin.spec.ts` pins each one beside the
 * Solidity name and line it was read from, which is the only honest check
 * available from a repository that does not contain the Solidity.
 */
export const EVM_CONSTANTS = {
  /**
   * `Constants.sol:147`. `redeemVoucherBatch` refuses more.
   *
   * Validated against `ArbGasInfo.getGasAccountingParams()` →
   * `maxTxGasLimit = 32,000,000` on both 4663 and 46630: the worst measured
   * batch of 64 spent 5,235,730 gas, 16.4 % of the limit, 6.11× headroom. That
   * measurement was taken against `MockUSDG`, roughly the cheapest possible
   * ERC-20; real USDG is an upgradeable proxy with a blocklist and a
   * redemption performs two transfers. This number does not move before it has
   * been re-measured against the real token.
   */
  MAX_REDEEM_BATCH: 64,
  /** `Constants.sol:38` — `WITHDRAW_DELAY_SECONDS = 3600`. */
  WITHDRAW_DELAY_SECONDS: 3_600,
  /** `Constants.sol:41` — `REDEEM_GRACE_SECONDS = 30 * 60`. */
  REDEEM_GRACE_SECONDS: 1_800,
  /** `Constants.sol:47` — `VOUCHER_MAX_LIFETIME_SECONDS = 5 * 60`. */
  VOUCHER_MAX_LIFETIME_SECONDS: 300,
  /** `Constants.sol:51` — `CLOCK_SKEW_TOLERANCE_SECONDS = 120`, one-sided. */
  CLOCK_SKEW_TOLERANCE_SECONDS: 120,
  /**
   * `Constants.sol:56` — 120 + 300 + 1 800. The widest a voucher can stay
   * redeemable, and the quantity `WITHDRAW_DELAY_SECONDS` has to exceed for a
   * withdraw request to be unable to outrun a voucher already signed.
   */
  MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS: 2_220,
  /**
   * `Constants.sol:87` — `SLASH_WINDOW_SECONDS = 86_400`. One width for two
   * rolling counters: the buyer's spend window and the provider's slash window.
   *
   * It is the denominator of `Window.decay`, which is why a redemption
   * pre-validator needs it — `spentInWindow` is not a level, it is a level plus
   * an anchor, and reading it without the decay refuses vouchers the chain
   * would settle.
   */
  SLASH_WINDOW_SECONDS: 86_400,
  /**
   * `Constants.sol` — `MAX_DELEGATION_LIFETIME_SECONDS = 365 * 86_400`. The
   * longest horizon one delegate authorisation may carry.
   */
  MAX_DELEGATION_LIFETIME_SECONDS: 31_536_000,
  /** `Constants.sol` — `MAX_DELEGATES_PER_PAYER = 16`. Revoking frees a place. */
  MAX_DELEGATES_PER_PAYER: 16,
  /**
   * `Constants.sol:152` — `MAX_SEQ_GAP = 1_000_000`. A redeemed voucher needs
   * `seq <= seqHigh + MAX_SEQ_GAP`, else `VoucherSeqGapTooLarge` (D-17). The
   * payment domain mirrors it as `VOUCHER_MAX_SEQ_GAP` so issuing and
   * admission refuse the same seqs; `constants-pin.spec.ts` holds the two
   * equal.
   */
  MAX_SEQ_GAP: VOUCHER_MAX_SEQ_GAP,
  /**
   * `Constants.sol:172` — `MAX_SIGNATURE_LIFETIME_SECONDS = 3600`. Every
   * `*BySig` door refuses `deadline > block.timestamp + 3600`
   * (`SignatureDeadlineTooFar`, D-18). The backend signs deadlines at chain
   * time + `VOUCHER_MAX_LIFETIME_SECONDS` (300), well inside it.
   */
  MAX_SIGNATURE_LIFETIME_SECONDS: 3_600,
} as const;

/**
 * The escrow call a buyer makes to fund their escrow, as its Solidity
 * signature.
 *
 * One literal, two readers: `EvmChainAdapter.buildPaymentRequirements` puts it
 * in the `402`'s `extra.method` and `EvmDepositRequirementsBuilder` puts it in
 * the `POST /deposits` response. Those are the advertisement and the
 * instruction for the **same** transaction, and two copies of the string is one
 * rename away from advertising one function and instructing another.
 *
 * `depositFor(address,uint64)` and not `transfer`: a plain ERC-20
 * transfer into `X402Escrow` moves the tokens and credits nobody.
 */
export const EVM_DEPOSIT_METHOD = 'depositFor(address,uint64)' as const;

/**
 * Where the three proxies and the settlement token live on one chain.
 *
 * Every address is the **proxy**, not the implementation: that is what an
 * EIP-712 `verifyingContract` names and what does not move across an upgrade.
 */
export interface EvmDeployment {
  readonly chainId: ChainId;
  readonly config: `0x${string}`;
  readonly stake: `0x${string}`;
  readonly escrow: `0x${string}`;
  readonly asset: `0x${string}`;
  /**
   * The escrow proxy's **implementation**, and the only address in this record
   * that is not a proxy.
   *
   * It is here because `VaultPort.assertVaultControl` needs something to
   * compare the live ERC-1967 slot against, and "control" on EVM is *"is the
   * code behind this address the code we deployed?"* — a question that has no
   * answer without a recorded expectation. Copied from
   * assay-evm's `deployments/<chainId>.json` → `contracts.X402Escrow.implementation`,
   * which is the same field `assay-evm/script/verify-deployment.sh` check 2 reads.
   *
   * **It moves on every upgrade, and that is the point.** An upgrade that does
   * not also update this value stops the reconciler, loudly, on its next pass
   * — which is the correct behaviour for an upgrade nobody recorded.
   */
  readonly escrowImplementation: `0x${string}`;
  /**
   * `X402Config.admin` — the OPERATIONAL key (`updateConfig`, `setPaused`, the
   * verifier registry, `cancelSlash`). It is **not** the upgrade authority:
   * since D-17 that is {@link owner}, and the owner appoints the admin.
   *
   * Recorded rather than read-and-trusted for the same reason as the
   * implementation: an admin that moved without being recorded is a change of
   * who can pause and re-parameterise the contracts that nobody recorded.
   * `deployments/<chainId>.json` → `admin` in assay-evm.
   */
  readonly admin: `0x${string}`;
  /**
   * `X402Config.owner()` — the UUPS upgrade authority of all three contracts
   * (the stake and escrow read `CONFIG.owner()` live) and the key that
   * appoints the admin. Kept cold (Ledger or Safe), moves in two steps, can
   * never be renounced (assay-evm D-17).
   *
   * Recorded for the same reason as {@link escrowImplementation}: an owner that
   * moved without being recorded is an upgrade authority that moved without
   * being recorded, and nothing else on chain would say so.
   * `deployments/<chainId>.json` → `owner` in assay-evm.
   */
  readonly owner: `0x${string}`;
  /**
   * `Multicall3` on this chain, when the slash executor may batch through it.
   * Optional and per chain: absent means one transaction per judgement.
   * (`MULTICALL3_ADDRESS` below is what viem's batched READS assume; batching
   * WRITES is opted into here, explicitly.)
   */
  readonly multicall3?: `0x${string}`;
}

/** DI token: `ReadonlyMap<ChainId, EvmDeployment>`. */
export const EVM_DEPLOYMENTS = 'EVM_DEPLOYMENTS';

/** DI token: `ReadonlyMap<ChainId, SanctionedEvmClient>`. */
export const EVM_RPC_CLIENTS = 'EVM_RPC_CLIENTS';

/**
 * Multicall3, at the address it has on every chain that has it.
 *
 * Deployed deterministically (Nick's method), so the address is the same
 * everywhere rather than per-chain configuration. viem batches `readContract`
 * through it, and without a `chain` carrying this address the client refuses
 * every batched read with `client chain not configured. multicallAddress is
 * required.` — which is what made the escrow walk fail once it stopped being
 * handed the wrong chain's rows.
 *
 * Presence is NOT assumed: `assertMulticallPresent` checks it at boot for each
 * enabled chain, because a chain without it fails at the first batched read
 * rather than at startup, and by then the only symptom is a reconciliation
 * that never completes. Measured on eip155:46630 on 2026-09-18: 7,618 bytes.
 */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
