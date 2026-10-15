import { parseAbi } from 'viem';

/**
 * The parts of `X402Escrow` this backend calls or decodes.
 *
 * Hand-written from assay-evm's `src/X402Escrow.sol` rather than generated, and
 * deliberately partial: a vendored 200 kB artifact is surface nobody reviews,
 * and every entry below is one somebody had to justify.
 * `abi-selectors.spec.ts` pins each signature to the selector the compiler
 * produced, each return type to the shape the compiler declared, and refuses
 * any entry that is not pinned.
 *
 * Three shapes to note:
 *
 * - `escrowOf` returns the whole twelve-field `Escrow` STRUCT. The mapping is
 *   `internal` and has no generated getter, so there is no narrower read.
 * - `redeemVoucherBatch` returns nothing and is **atomic**: one bad voucher
 *   reverts all 64. There is no partial success to handle.
 * - There is no `withdrawBySig`, by design. `withdraw()` is
 *   `msg.sender`-only, pays `msg.sender`, and takes no destination.
 *
 * The deposit path built here is `approve` + `depositFor`; the contract has no
 * other deposit door (D-18 removed the Permit2 one).
 */
export const X402_ESCROW_ABI = parseAbi([
  'struct Voucher { address payer; address provider; uint64 amount; bytes32 resourceHash; bytes32 requestHash; uint64 seq; uint64 issuedAt; uint64 expiresAt; }',
  'struct Delegation { uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 validUntil; uint32 listPosition; bool revoked; }',
  'struct Escrow { uint128 balance; uint64 seqHigh; uint64 authNonce; uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 withdrawRequested; uint64 withdrawAvailableAt; uint128 totalRedeemed; uint128 totalWithdrawn; uint128 totalFunded; }',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  /**
   * One of `EvmVaultService.assertVaultControl`'s three reads. The
   * settlement token the escrow was initialised with, so a vault balance is
   * never published in a denomination the contract does not actually hold.
   *
   * `CONFIG()` and `STAKE()` are the same shape and are
   * deliberately NOT vendored beside it: nothing reads them, and an ABI entry
   * is a call site waiting to exist.
   */
  'function ASSET() view returns (address)',
  'function escrowOf(address buyer) view returns (Escrow)',
  'function totalEscrowed() view returns (uint128)',
  'function deposit(uint64 amount)',
  'function depositFor(address buyer, uint64 amount)',
  'function redeemVoucher(Voucher v, bytes sig)',
  'function redeemVoucherBatch(Voucher[] vs, bytes[] sigs)',
  'function setLimits(uint64 maxVoucherAmount, uint64 maxPerWindow)',
  'function setLimitsBySig(address buyer, uint64 maxVoucherAmount, uint64 maxPerWindow, uint64 nonce, uint64 deadline, bytes sig)',
  'function requestWithdraw(uint64 amount)',
  'function requestWithdrawBySig(address buyer, uint64 amount, uint64 nonce, uint64 deadline, bytes sig)',
  'function withdraw()',
  /**
   * Agent payment delegation. The two READS are how the backend mirrors the
   * contract's voucher rule off chain (a delegate's record, with its caps and
   * its own window) and lists a payer's delegates; the two `…BySig` writes are
   * the relayed doors a payer without gas signs for. The direct
   * `authorizeDelegate`/`revokeDelegate` are the payer's own and are not
   * vendored: nothing here may send them.
   */
  'function delegationOf(address payer, address delegate) view returns (Delegation)',
  'function delegatesOf(address payer) view returns (address[])',
  /**
   * D-21 (assay-evm f814629): the caps `_redeem` applies NOW — a cap the payer
   * lowered less than `TIGHTEN_DELAY_SECONDS` ago still counts, and a revoked
   * delegate signs for that long. Delegate caps `0` = that delegate cannot sign
   * now. Absent before the upgrade; `EvmTightenDelayProbe` calls it to tell.
   */
  'function effectiveCapsOf(address payer, address delegate) view returns (uint64 maxVoucherAmount, uint64 maxPerWindow, uint64 delegateMaxVoucherAmount, uint64 delegateMaxPerWindow)',
  'function authorizeDelegateBySig(address payer, address delegate, uint64 maxVoucherAmount, uint64 maxPerWindow, uint64 validUntil, uint64 nonce, uint64 deadline, bytes sig)',
  'function revokeDelegateBySig(address payer, address delegate, uint64 nonce, uint64 deadline, bytes sig)',
  'event Deposited(address indexed buyer, address indexed funder, uint64 amount, uint128 balance)',
  'event VoucherRedeemed(address indexed payer, address indexed provider, bytes32 requestHash, bytes32 resourceHash, uint64 amount, uint64 fee, uint64 seq, uint16 takeRateBps, uint64 spentInWindow)',
  'event WithdrawRequested(address indexed buyer, uint64 amount, uint64 availableAt)',
  'event EscrowWithdrawn(address indexed buyer, uint64 requested, uint64 amount)',
  'event EscrowLimitsSet(address indexed buyer, uint64 maxVoucherAmount, uint64 maxPerWindow)',
]);

/**
 * `X402Config`, read-only.
 *
 * **Nothing in this backend writes to it.** `updateConfig`, `setPaused`,
 * `registerVerifier` and `revokeVerifier` are the ADMIN's; `setAdmin`,
 * `transferOwnership`, `acceptOwnership`, `renounceOwnership` and
 * `initializeV2` are the OWNER's (D-17). Both keys are held by humans, and
 * every one of those writes is deliberately absent so that no call site can
 * reach for one — an ABI entry is a call site waiting to exist, and
 * `abi-selectors.spec.ts` fails if any of them appears.
 *
 * `owner()` is the UUPS upgrade authority of all three contracts and
 * `pendingOwner()` is the incoming key of a two-step transfer in progress;
 * `EvmVaultService.assertVaultControl` reads the first. `admin()` is the
 * operational key and is NOT the upgrade authority.
 *
 * `updateConfig` also has no compare-and-swap. That is safe only because the
 * admin is one key, and *"read `params()` in the same block you sign from"* is
 * **not** a defence: it appears nowhere here and must not.
 */
export const X402_CONFIG_ABI = parseAbi([
  'struct ParamSet { address treasury; address redeemer; uint64 unbondingPeriodSeconds; uint64 minimumStake; uint64 penaltyAmount; uint64 verifierDailyCap; uint16 takeRateBps; uint16 slashAgentBps; uint16 slashPlatformBps; uint16 slashCapBps; }',
  'struct VerifierKey { uint64 registeredAt; uint64 expiresAt; uint64 revokedAt; bool registered; bool revoked; }',
  'function params() view returns (ParamSet)',
  'function paused() view returns (bool)',
  'function admin() view returns (address)',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function canSign(address verifier) view returns (bool)',
  'function verifierKey(address verifier) view returns (VerifierKey)',
  /**
   * The dispute upgrade's three reads (assay-evm D-19); the backend assumes
   * the upgraded Config. `assertActive` is not vendored — it is the
   * contract's own guard, and the backend reads the two facts it combines
   * (`paused`, `blocked`) instead.
   */
  'function arbiter() view returns (address)',
  'function slashDelaySeconds() view returns (uint64)',
  'function blocked(address account) view returns (bool)',
]);

/**
 * `X402Config`'s events the chain-state indexer reads (`EvmChainStateIndexer`):
 * `PauseToggled` and `BlockedSet` into Postgres; `AdminSet`, `ConfigUpdated`
 * (treasury, bps, caps), `VerifierRevokedEvent`, `ArbiterSet`,
 * `SlashDelaySet` and `VerifierRegistered` as CRITICAL alerts (the levers a
 * stolen admin key pulls); `PauseToggled`, an unblock (`BlockedSet` false,
 * which only the admin can send) and a block by the arbiter as a WARN. Events
 * only, no function: nothing here may write the Config.
 */
export const X402_CONFIG_EVENTS_ABI = parseAbi([
  'struct ParamSet { address treasury; address redeemer; uint64 unbondingPeriodSeconds; uint64 minimumStake; uint64 penaltyAmount; uint64 verifierDailyCap; uint16 takeRateBps; uint16 slashAgentBps; uint16 slashPlatformBps; uint16 slashCapBps; }',
  'event PauseToggled(address indexed admin, bool paused, uint64 at)',
  'event AdminSet(address indexed previousAdmin, address indexed newAdmin)',
  'event ConfigUpdated(address indexed admin, ParamSet params)',
  'event VerifierRevokedEvent(address indexed verifier, address indexed admin, uint64 revokedAt)',
  'event BlockedSet(address indexed account, bool blocked, address indexed by)',
  'event ArbiterSet(address indexed previousArbiter, address indexed newArbiter)',
  'event SlashDelaySet(uint64 previousDelay, uint64 newDelay)',
  'event VerifierRegistered(address indexed verifier, address indexed admin, bytes32 label, uint64 registeredAt, uint64 expiresAt)',
]);

/**
 * ERC-1967 `Upgraded`, watched on all three proxies (Config, Stake, Escrow):
 * an implementation swap is the biggest lever a stolen owner key pulls, so it
 * is a CRITICAL alert (audit E-6). Events only.
 */
export const X402_PROXY_EVENTS_ABI = parseAbi(['event Upgraded(address indexed implementation)']);

/**
 * `setBlocked(account, true)` — ENCODED, never sent, for the ARBITER's wallet
 * (`X402Config.setBlocked` lets the arbiter block and only the admin unblock).
 *
 * Kept apart from {@link X402_CONFIG_ABI} so the Config's read surface stays
 * read-only, and imported by `EvmSlashExecutor` alone (`abi-selectors.spec.ts`
 * enforces it): the backend holds no arbiter key, so this calldata is handed
 * to an operator and signed by a person.
 */
export const X402_CONFIG_ARBITER_ABI = parseAbi([
  'function setBlocked(address account, bool value)',
]);

/**
 * `X402Stake`, read-only here.
 *
 * The four slash-lifecycle writes (`proposeSlash`, `executeSlash`,
 * `cancelSlash`, `expireSlash`) are NOT in this constant. They live in
 * {@link X402_STAKE_SLASH_ABI}, which only `EvmSlashExecutor` imports
 * (`abi-selectors.spec.ts` enforces both halves), so a stake reader or an
 * intent builder cannot reach for one.
 *
 * `ProviderStake` carries a `uint64 __gap` at position 7 that IS on the wire,
 * and `SlashRecord` carries two (`uint32 __gap`, `uint32 __gap2`). Decode them,
 * ignore them, never renumber around them: they are what keeps the field after
 * them at the offset the deployed bytecode writes.
 *
 * `SlashRecord.disputedAt` is the dispute upgrade's thirteenth field (D-19).
 * Read a record through `readSlashRecord` / `decodeSlashRecord`
 * (`evm-slash-record.ts`).
 */
export const X402_STAKE_ABI = parseAbi([
  'struct ProviderStake { uint128 bonded; uint64 unbonding; uint64 unbondingStartedAt; uint64 slashedInWindow; uint64 slashWindowStartedAt; uint64 pendingSlash; uint64 __gap; uint128 totalDeposited; uint128 totalWithdrawn; uint128 totalSlashed; }',
  'struct SlashRecord { address provider; uint8 status; uint64 penalty; address beneficiary; uint64 proposedAt; uint32 __gap; address verifier; uint64 executableAt; uint32 __gap2; uint64 reserved; uint64 capAllowance; uint64 applied; uint64 executedAt; bytes32 policy; uint64 disputedAt; }',
  'function stakeOf(address provider) view returns (ProviderStake)',
  'function bondedOf(address provider) view returns (uint64)',
  'function withdrawableOf(address provider) view returns (uint64)',
  'function slashRecordOf(bytes32 requestId) view returns (SlashRecord)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  // The provider's own doors — built by `EvmStakeIntentBuilder`, never sent by
  // this process.
  'function depositStake(uint64 amount)',
  'function depositStakeFor(address provider, uint64 amount)',
  'function requestUnstake(uint64 amount)',
  'function withdrawStake(uint64 amount)',
  'event StakeDeposited(address indexed provider, address indexed funder, uint64 amount, uint128 bonded)',
]);

/**
 * The slash lifecycle on `X402Stake`, for `EvmSlashExecutor` and nothing else.
 *
 * - `proposeSlash` is authorised by the **verifier's signature** over the
 *   `SlashAttestation`, never by `msg.sender`: the platform cannot slash
 *   without an attestation a registered verifier key signed, because the
 *   contract recovers the signer and calls `CONFIG.assertCanSign` itself.
 * - `executeSlash` and `expireSlash` are permissionless; every amount and the
 *   beneficiary are read off the record frozen at proposal.
 * - `cancelSlash` is `CONFIG.admin()`- or `CONFIG.arbiter()`-only. It is
 *   vendored to ENCODE the unsigned calldata handed to that person, and is
 *   never sent by this process.
 * - The dispute upgrade's batch doors (D-19), all ENCODED for a person and
 *   never sent: `disputeSlashBatch` is the provider's own (`msg.sender ==
 *   record.provider`), `upholdSlashBatch` the arbiter's, `cancelSlashBatch`
 *   the admin's or the arbiter's. Each is atomic — one bad id reverts the
 *   whole batch — so every builder pre-filters with `slashRecordOf`.
 *
 * The events are decoded off receipts to learn what a batched call did — a
 * `Multicall3` receipt carries no per-call return data.
 */
export const X402_STAKE_SLASH_ABI = parseAbi([
  'struct SlashAttestation { bytes32 requestId; address provider; address beneficiary; uint8 status; uint64 penalty; bytes32 policy; uint64 issuedAt; uint64 expiresAt; }',
  'function proposeSlash(SlashAttestation a, bytes sig)',
  'function executeSlash(bytes32 requestId)',
  'function expireSlash(bytes32 requestId)',
  'function cancelSlash(bytes32 requestId)',
  'function disputeSlashBatch(bytes32[] requestIds)',
  'function upholdSlashBatch(bytes32[] requestIds)',
  'function cancelSlashBatch(bytes32[] requestIds)',
  'event SlashProposed(bytes32 indexed requestId, address indexed provider, address indexed verifier, address beneficiary, bytes32 policy, uint64 penalty, uint64 reserved, uint64 capAllowance, uint64 pendingSlash, uint64 proposedAt, uint64 executableAt)',
  'event SlashExecuted(bytes32 indexed requestId, address indexed provider, address indexed verifier, address beneficiary, bytes32 policy, uint64 penalty, uint64 applied, uint64 agentAmount, uint64 platformAmount, uint64 providerAmount, uint16 slashAgentBps, uint16 slashPlatformBps, uint64 released, uint64 pendingSlash, uint128 bonded, uint64 unbonding, uint64 executedAt, uint64 proposedAt)',
  'event SlashCancelled(bytes32 indexed requestId, address indexed provider, uint8 reason, uint64 released, uint64 pendingSlash, uint64 cancelledAt)',
  'event SlashDisputed(bytes32 indexed requestId, address indexed provider, uint64 disputedAt, uint64 executableAt)',
  'event SlashUpheld(bytes32 indexed requestId, address indexed provider, address indexed arbiter, uint64 executableAt)',
]);

/**
 * The events `EvmSlashProposalWatcher` reads (review H-1, and the dispute
 * upgrade): `SlashProposed` to find records this platform did not plan,
 * `SlashDisputed`, `SlashUpheld` and `SlashCancelled` to mirror a provider's
 * on-chain dispute and the arbiter's ruling onto the case, and `SlashExecuted`
 * to mirror an execution whoever sent it (BUG-R13-D-03). Kept apart from
 * {@link X402_STAKE_SLASH_ABI} so the slash WRITES stay reachable from the
 * slash executor only: this constant holds events and no function.
 */
export const X402_SLASH_WATCH_EVENTS_ABI = parseAbi([
  'event SlashProposed(bytes32 indexed requestId, address indexed provider, address indexed verifier, address beneficiary, bytes32 policy, uint64 penalty, uint64 reserved, uint64 capAllowance, uint64 pendingSlash, uint64 proposedAt, uint64 executableAt)',
  'event SlashDisputed(bytes32 indexed requestId, address indexed provider, uint64 disputedAt, uint64 executableAt)',
  'event SlashUpheld(bytes32 indexed requestId, address indexed provider, address indexed arbiter, uint64 executableAt)',
  'event SlashCancelled(bytes32 indexed requestId, address indexed provider, uint8 reason, uint64 released, uint64 pendingSlash, uint64 cancelledAt)',
  'event SlashExecuted(bytes32 indexed requestId, address indexed provider, address indexed verifier, address beneficiary, bytes32 policy, uint64 penalty, uint64 applied, uint64 agentAmount, uint64 platformAmount, uint64 providerAmount, uint16 slashAgentBps, uint16 slashPlatformBps, uint64 released, uint64 pendingSlash, uint128 bonded, uint64 unbonding, uint64 executedAt, uint64 proposedAt)',
]);

/**
 * `Multicall3.aggregate3` — the one batching door. Each call carries
 * `allowFailure: true`, so one refused judgement does not revert the others;
 * the per-call result is learned by simulating the batch first (`eth_call`
 * returns the `Result[]`) and confirmed afterwards from the receipt's events.
 */
export const MULTICALL3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

/**
 * Only what a deposit path needs.
 *
 * USDG has neither EIP-2612 nor EIP-3009 — measured (`docs/chain-facts.md` in
 * assay-evm): `DOMAIN_SEPARATOR()`, `nonces()` and `authorizationState()` all revert —
 * so there is no permit to vendor and the first deposit of a buyer's life
 * cannot be gasless.
 */
export const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
