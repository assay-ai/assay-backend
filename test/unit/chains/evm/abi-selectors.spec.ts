import { execSync } from 'node:child_process';

import { AbiParameter, toEventSelector, toFunctionSelector } from 'viem';

import { EVM_ERROR_BY_SELECTOR, evmErrorName } from '@modules/chains/evm/abi/error-selectors';
import {
  ERC20_ABI,
  X402_CONFIG_ABI,
  X402_ESCROW_ABI,
  MULTICALL3_ABI,
  X402_CONFIG_ARBITER_ABI,
  X402_CONFIG_EVENTS_ABI,
  X402_PROXY_EVENTS_ABI,
  X402_SLASH_WATCH_EVENTS_ABI,
  X402_STAKE_ABI,
  X402_STAKE_SLASH_ABI,
} from '@modules/chains/evm/abi/x402.abi';

/**
 * The backend's copy of the contract interface, pinned to what the COMPILER
 * produced.
 *
 * `evm/out/*.json` lives in the workspace, not in this submodule, and is
 * git-ignored — so this suite cannot read it at run time. Every literal below
 * was instead **extracted from a compiler artifact or from `cast`**, never
 * typed by reading the Solidity:
 *
 * - the function selectors come from `.methodIdentifiers` in
 *   `evm/out/<Contract>.sol/<Contract>.json`;
 * - the argument and return shapes come from the `abi` array of the same files,
 *   rendered to canonical form;
 * - the 83 error selectors (81 from `Errors.sol`, two from OpenZeppelin's
 *   `Ownable`) come from `cast sig '<Name>()'` on the pinned
 *   Foundry build (1.2.1-nightly, commit `7e68208e`), which is a **different
 *   keccak implementation from viem's** — so the comparison is a pin and not a
 *   restatement of the derivation.
 *
 * Extracted 2026-09-09. This is the control an earlier version lacked: its typehash gate
 * compared against a literal somebody had typed by reading the same source the
 * code was written from, so five of seven drift controls stayed green while the
 * thing they guarded had moved.
 *
 * ## What a selector cannot see
 *
 * A selector is `keccak(name + argument types)` — the RETURN type is not in it.
 * `escrowOf(address)` keeps selector `0xe038c3da` however its twelve-field
 * struct is ordered, and a mis-ordered struct decodes a balance out of a
 * sequence number, silently. That is what {@link RETURN_SHAPES} exists for, and
 * why the pin is two tables rather than one.
 */

/** `[selector, canonical signature, canonical return shape]`, from the artifacts. */
type Pin = readonly [`0x${string}`, string, string];

const ESCROW_PINS: readonly Pin[] = [
  ['0x3644e515', 'DOMAIN_SEPARATOR()', '(bytes32)'],
  [
    '0xe038c3da',
    'escrowOf(address)',
    '((uint128 balance,uint64 seqHigh,uint64 authNonce,uint64 maxVoucherAmount,uint64 maxPerWindow,uint64 spentInWindow,uint64 windowStartedAt,uint64 withdrawRequested,uint64 withdrawAvailableAt,uint128 totalRedeemed,uint128 totalWithdrawn,uint128 totalFunded))',
  ],
  // Extracted from `.methodIdentifiers` in assay-evm's
  // `out/X402Escrow.sol/X402Escrow.json` and confirmed by `cast sig
  // 'ASSET()'` on the pinned build — the artifact declares its output as
  // `address` with an empty name (`internalType: contract IERC20`).
  ['0x4800d97f', 'ASSET()', '(address)'],
  ['0xf9168231', 'totalEscrowed()', '(uint128)'],
  ['0x13765838', 'deposit(uint64)', '()'],
  ['0xe9efa60a', 'depositFor(address,uint64)', '()'],
  [
    '0x73f9b9b0',
    'redeemVoucher((address,address,uint64,bytes32,bytes32,uint64,uint64,uint64),bytes)',
    '()',
  ],
  [
    '0x9543d544',
    'redeemVoucherBatch((address,address,uint64,bytes32,bytes32,uint64,uint64,uint64)[],bytes[])',
    '()',
  ],
  ['0x3f34c514', 'setLimits(uint64,uint64)', '()'],
  ['0x47f26271', 'setLimitsBySig(address,uint64,uint64,uint64,uint64,bytes)', '()'],
  ['0x2a1561f5', 'requestWithdraw(uint64)', '()'],
  ['0x4129519f', 'requestWithdrawBySig(address,uint64,uint64,uint64,bytes)', '()'],
  ['0x3ccfd60b', 'withdraw()', '()'],
  // Agent payment delegation — `cast sig` on the pinned build, agreeing with
  // `.methodIdentifiers` of the delegation branch's artifact.
  [
    '0x628da527',
    'delegationOf(address,address)',
    '((uint64 maxVoucherAmount,uint64 maxPerWindow,uint64 spentInWindow,uint64 windowStartedAt,uint64 validUntil,uint32 listPosition,bool revoked))',
  ],
  ['0x7de5b8ed', 'delegatesOf(address)', '(address[])'],
  [
    '0x2365427e',
    'authorizeDelegateBySig(address,address,uint64,uint64,uint64,uint64,uint64,bytes)',
    '()',
  ],
  ['0x7aac242e', 'revokeDelegateBySig(address,address,uint64,uint64,bytes)', '()'],
];

const CONFIG_PINS: readonly Pin[] = [
  [
    '0xcff0ab96',
    'params()',
    '((address treasury,address redeemer,uint64 unbondingPeriodSeconds,uint64 minimumStake,uint64 penaltyAmount,uint64 verifierDailyCap,uint16 takeRateBps,uint16 slashAgentBps,uint16 slashPlatformBps,uint16 slashCapBps))',
  ],
  ['0x5c975abb', 'paused()', '(bool)'],
  ['0xf851a440', 'admin()', '(address)'],
  // The D-17 owner role (OpenZeppelin `Ownable2StepUpgradeable`): `cast sig
  // 'owner()'` and `cast sig 'pendingOwner()'`. Reads only.
  ['0x8da5cb5b', 'owner()', '(address)'],
  ['0xe30c3978', 'pendingOwner()', '(address)'],
  ['0x7ef30520', 'canSign(address)', '(bool)'],
  [
    '0x4d44b5b7',
    'verifierKey(address)',
    '((uint64 registeredAt,uint64 expiresAt,uint64 revokedAt,bool registered,bool revoked))',
  ],
  // The dispute upgrade (D-19): `.methodIdentifiers` of assay-evm 99f98ed's
  // `out/X402Config.sol/X402Config.json`, agreeing with `cast sig`.
  ['0xfe25e00a', 'arbiter()', '(address)'],
  ['0x41985d41', 'slashDelaySeconds()', '(uint64)'],
  ['0xe5962195', 'blocked(address)', '(bool)'],
];

/** `setBlocked` alone — encoded for the arbiter's wallet, never sent (`cast sig`). */
const CONFIG_ARBITER_PINS: readonly Pin[] = [['0x000af2a1', 'setBlocked(address,bool)', '()']];

const STAKE_PINS: readonly Pin[] = [
  [
    '0x42623360',
    'stakeOf(address)',
    '((uint128 bonded,uint64 unbonding,uint64 unbondingStartedAt,uint64 slashedInWindow,uint64 slashWindowStartedAt,uint64 pendingSlash,uint64 __gap,uint128 totalDeposited,uint128 totalWithdrawn,uint128 totalSlashed))',
  ],
  ['0x75185ae3', 'bondedOf(address)', '(uint64)'],
  ['0xfa8c00d4', 'withdrawableOf(address)', '(uint64)'],
  [
    '0x8e00f4d1',
    'slashRecordOf(bytes32)',
    // assay-evm 99f98ed: `disputedAt` appended as the thirteenth field (D-19).
    '((address provider,uint8 status,uint64 penalty,address beneficiary,uint64 proposedAt,uint32 __gap,address verifier,uint64 executableAt,uint32 __gap2,uint64 reserved,uint64 capAllowance,uint64 applied,uint64 executedAt,bytes32 policy,uint64 disputedAt))',
  ],
  ['0x3644e515', 'DOMAIN_SEPARATOR()', '(bytes32)'],
  // The provider's own doors — built unsigned by `EvmStakeIntentBuilder`,
  // never sent by the backend. From `.methodIdentifiers` in assay-evm's
  // `out/X402Stake.sol/X402Stake.json`, agreeing with `cast sig`.
  ['0x208d4960', 'depositStake(uint64)', '()'],
  ['0x9ff2f1ae', 'depositStakeFor(address,uint64)', '()'],
  ['0x04e4841a', 'requestUnstake(uint64)', '()'],
  ['0x2ce7777f', 'withdrawStake(uint64)', '()'],
];

/**
 * USDG is not one of the compiled contracts — its source is the issuer's, not this
 * repository's — so these four come from `cast sig` on the standard ERC-20
 * signatures. `decimals()` is the one measured fact about the real token that
 * the backend consumes (`6`, recorded in assay-evm's `docs/chain-facts.md`),
 * and `approve` is the only write: mistyping its `uint256` as `uint64` would send a deposit approval to a
 * function that does not exist.
 */
const ERC20_PINS: readonly Pin[] = [
  ['0x313ce567', 'decimals()', '(uint8)'],
  ['0x70a08231', 'balanceOf(address owner)', '(uint256)'],
  ['0xdd62ed3e', 'allowance(address owner,address spender)', '(uint256)'],
  ['0x095ea7b3', 'approve(address spender,uint256 amount)', '(bool)'],
];

/**
 * The slash lifecycle and the batching door — vendored separately from
 * `X402_STAKE_ABI` so only `EvmSlashExecutor` can reach them. Selectors from
 * `abiFunctions` in assay-evm's `deployments/46630.json`, agreeing with
 * `cast sig`; `aggregate3` from `cast sig 'aggregate3((address,bool,bytes)[])'`.
 */
const STAKE_SLASH_PINS: readonly Pin[] = [
  [
    '0x1dae0660',
    'proposeSlash((bytes32,address,address,uint8,uint64,bytes32,uint64,uint64),bytes)',
    '()',
  ],
  ['0xb850cdf7', 'executeSlash(bytes32)', '()'],
  ['0xb46940b6', 'expireSlash(bytes32)', '()'],
  ['0xa91e3b8e', 'cancelSlash(bytes32)', '()'],
  // The dispute upgrade's batch doors (D-19), from `.methodIdentifiers` of
  // assay-evm 99f98ed's `out/X402Stake.sol/X402Stake.json`, agreeing with
  // `cast sig`. Encoded for a person's wallet, never sent.
  ['0xa384e225', 'disputeSlashBatch(bytes32[])', '()'],
  ['0xfe08fd47', 'upholdSlashBatch(bytes32[])', '()'],
  ['0x3e87bd05', 'cancelSlashBatch(bytes32[])', '()'],
];

const MULTICALL3_PINS: readonly Pin[] = [
  [
    '0x82ad56cb',
    'aggregate3((address,bool,bytes)[])',
    '((bool success,bytes returnData)[] returnData)',
  ],
];

const SUITES = [
  ['escrow', X402_ESCROW_ABI, ESCROW_PINS],
  ['config', X402_CONFIG_ABI, CONFIG_PINS],
  ['config-arbiter', X402_CONFIG_ARBITER_ABI, CONFIG_ARBITER_PINS],
  ['stake', X402_STAKE_ABI, STAKE_PINS],
  ['stake-slash', X402_STAKE_SLASH_ABI, STAKE_SLASH_PINS],
  ['multicall3', MULTICALL3_ABI, MULTICALL3_PINS],
  ['erc20', ERC20_ABI, ERC20_PINS],
] as const;

/**
 * A parameter list rendered as `(uint128 balance,uint64 seqHigh)` — types AND
 * names.
 *
 * The names are the point. `escrowOf` returns twelve fields of which nine are
 * `uint64`, so a type-only rendering is identical after swapping `seqHigh` and
 * `authNonce` — and the selector cannot see a return type at all. Measured:
 * with a type-only pin, that swap passed every test in this file. viem decodes
 * a struct into a named object and the readers reach for `.balance`, so a
 * renamed or reordered field is a wrong number under a right name.
 */
function canonical(params: readonly AbiParameter[]): string {
  const render = (param: AbiParameter): string => {
    const type =
      'components' in param && param.components
        ? `${canonical(param.components)}${param.type.slice('tuple'.length)}`
        : param.type;
    return param.name ? `${type} ${param.name}` : type;
  };
  return `(${params.map(render).join(',')})`;
}

describe('the vendored ABI matches the compiled contracts', () => {
  describe.each(SUITES)('%s', (name, abi, pins) => {
    it.each(pins)('%s is %s', (selector, signature) => {
      // Pins the LITERAL against the signature. If somebody widens a `uint64`
      // to a `uint256` in the signature string, the derived selector moves off
      // this literal and the call reaches a function that does not exist.
      expect(toFunctionSelector(signature)).toBe(selector);
    });

    it('every pinned signature is actually in the vendored ABI', () => {
      // Without this the loop above tests viem and nothing else: it would pass
      // against an EMPTY abi.
      const present = new Set(
        abi.filter((entry) => entry.type === 'function').map((entry) => toFunctionSelector(entry)),
      );
      expect([...pins].map(([selector]) => selector).filter((s) => !present.has(s))).toEqual([]);
    });

    it('vendors nothing beyond what is pinned', () => {
      // The other direction. An ABI entry is a call site waiting to exist:
      // `updateConfig`, `setPaused`, `registerVerifier`, `revokeVerifier` and
      // the four slash writes belong to the admin or the slash path, and are absent on
      // purpose. An unpinned entry arriving here is how one of them gets
      // vendored and then called.
      const present = abi
        .filter((entry) => entry.type === 'function')
        .map((entry) => toFunctionSelector(entry))
        .sort();
      expect(present).toEqual([...pins].map(([selector]) => selector).sort());
    });

    it('returns the shapes the compiler declared, which no selector can see', () => {
      const bySelector = new Map(
        abi
          .filter((entry) => entry.type === 'function')
          .map((entry) => [toFunctionSelector(entry), canonical(entry.outputs)] as const),
      );
      for (const [selector, signature, outputs] of pins) {
        expect({ signature, outputs: bySelector.get(selector) }).toEqual({ signature, outputs });
      }
    });
  });

  it('pins the slash events by topic, as cast computed them', () => {
    const topics = new Map(
      X402_STAKE_SLASH_ABI.filter((entry) => entry.type === 'event').map(
        (entry) => [entry.name, toEventSelector(entry)] as const,
      ),
    );
    expect(Object.fromEntries(topics)).toEqual({
      SlashProposed: '0x89a06db4f05c4eb0313f470e883eeec82e71b9526b56332373ea25030ac52457',
      SlashExecuted: '0x796048ad6bc167288173ac09bbc37852a68c771d44255cf3f9f3c9181d1c8025',
      SlashCancelled: '0xd49e8d4811b1f1cee769ed651b311fedc3dee19890a75297949c7316de37ac08',
      // `cast sig-event` on the D-19 signatures.
      SlashDisputed: '0x71dcb2ee04ff61961c8f4e7a01db35a26b8d22805252ed7551752962849d1cae',
      SlashUpheld: '0x1c63e1dc5cf373fdb9eeaace59066465ab6345c63c20d6fbfff7c51687299364',
    });
  });

  it('watches exactly the proposal, dispute, ruling and cancel events, with the slash ABI topics', () => {
    const slashTopics = new Map(
      X402_STAKE_SLASH_ABI.filter((entry) => entry.type === 'event').map(
        (entry) => [entry.name, toEventSelector(entry)] as const,
      ),
    );
    const watched = X402_SLASH_WATCH_EVENTS_ABI.map((entry) => {
      expect(entry.type).toBe('event');
      return [entry.name, toEventSelector(entry)] as const;
    });
    expect(watched.map(([name]) => name)).toEqual([
      'SlashProposed',
      'SlashDisputed',
      'SlashUpheld',
      'SlashCancelled',
    ]);
    for (const [name, topic] of watched) expect(topic).toBe(slashTopics.get(name));
  });

  it('pins the Config events the chain-state indexer reads, as cast computed them', () => {
    expect(X402_CONFIG_EVENTS_ABI.every((entry) => entry.type === 'event')).toBe(true);
    expect(
      Object.fromEntries(
        X402_CONFIG_EVENTS_ABI.map((entry) => [entry.name, toEventSelector(entry)]),
      ),
    ).toEqual({
      PauseToggled: '0x961373cd433c8ca67a43995ef5ebe71bec5d8a9fe7d599aaf511dbabc5e1686c',
      BlockedSet: '0xe542f9e64ac19b6755a8df86c41b0b8e0fd7a37565a0b79291c2b5383e6a4a15',
      ArbiterSet: '0xa99fc739cab6b19d8ee27aaf57eabd8d86b73474801240c86a747a5f5ee88841',
      SlashDelaySet: '0xe92892ac23b44eec891739e9373975ea3d0390fff6945b656d711465fa06a44a',
      VerifierRegistered: '0xf548a4789950d0f1776ed9cb2587f9c617dd22bcaf73b7e11671ea12a11788a9',
      // Audit E-6, from the compiled X402Config artifact.
      AdminSet: '0xbf265e8326285a2747e33e54d5945f7111f2b5edb826eb8c08d4677779b3ff97',
      ConfigUpdated: '0x8e7fa7a1420deb5f5e4a066cf608648e5033204e61af8207cde6761776d5d78f',
      VerifierRevokedEvent: '0x09d81452cebb749c6fa606928a01c3693c6dfc54af1b5dadfb01349c0b93d345',
    });
  });

  it('pins the ERC-1967 Upgraded event watched on all three proxies', () => {
    expect(X402_PROXY_EVENTS_ABI.map((entry) => [entry.name, toEventSelector(entry)])).toEqual([
      ['Upgraded', '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b'],
    ]);
  });

  it('lets only the slash executor import the arbiter Config ABI', () => {
    const hits = execSync(`grep -rl "X402_CONFIG_ARBITER_ABI" src`, {
      cwd: `${__dirname}/../../../..`,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .sort();
    expect(hits).toEqual([
      'src/modules/chains/evm/abi/x402.abi.ts',
      'src/modules/chains/evm/evm-slash-executor.service.ts',
    ]);
  });

  it('lets only the slash executor import the slash ABI', () => {
    // An ABI entry is a call site waiting to exist. The slash writes are
    // reachable from exactly one class.
    const hits = execSync(`grep -rl "X402_STAKE_SLASH_ABI" src`, {
      cwd: `${__dirname}/../../../..`,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .sort();
    expect(hits).toEqual([
      'src/modules/chains/evm/abi/x402.abi.ts',
      'src/modules/chains/evm/evm-slash-executor.service.ts',
    ]);
  });

  it('vendors no writer the admin ledger owns, by name', () => {
    // Belt and braces over the selector check above, and the one that reads as
    // an instruction to a future editor rather than as a hash comparison.
    const names: readonly string[] = [
      ...X402_CONFIG_ABI,
      ...X402_CONFIG_EVENTS_ABI,
      ...X402_STAKE_ABI,
      ...X402_ESCROW_ABI,
    ]
      .filter((entry) => entry.type === 'function')
      .map((entry) => entry.name);
    for (const forbidden of [
      'updateConfig',
      'setPaused',
      'registerVerifier',
      'revokeVerifier',
      'proposeSlash',
      'executeSlash',
      'cancelSlash',
      'expireSlash',
      'upgradeToAndCall',
      // The OWNER's doors (D-17). The owner is a cold key held by a human.
      'setAdmin',
      'transferOwnership',
      'acceptOwnership',
      'renounceOwnership',
      'initializeV2',
      // The dispute upgrade's admin doors (D-19), and the blocklist writer,
      // which only the arbiter-only constant may carry.
      'setArbiter',
      'setSlashDelay',
      'setBlocked',
    ]) {
      expect({ forbidden, vendored: names.includes(forbidden) }).toEqual({
        forbidden,
        vendored: false,
      });
    }
  });
});

/**
 * Every `error X();` in `assay-evm/src/Errors.sol`, name and selector, plus
 * the two OpenZeppelin Ownable errors `X402Config` raises.
 *
 * The names were extracted mechanically from the Solidity
 * (`grep '^error' src/Errors.sol` → 81 hits, every one zero-argument) on
 * 2026-10-13, after D-17/D-18, and again at assay-evm 99f98ed (88 hits: the
 * dispute upgrade's seven appended), and at 6865b24 (95 hits: a4f97ab's and
 * the audit fix round's seven appended), and at 9f036a3 (91: the simplify
 * round removed four). Each selector is `cast sig '<Name>()'`
 * on the pinned Foundry build (1.2.1-nightly), the last seven viem's keccak
 * cross-checked against the compiled ABIs. `target-branch-pin.spec.ts` checks
 * the list against the branch the backend targets (audit T-3).
 *
 * All are pinned rather than a sample: pinning four leaves the rest free to
 * be misspelled, and a misspelled name produces a selector that no revert will
 * ever carry — so the table reports `UNKNOWN_REVERT` for a refusal it was
 * written to name, and no test notices.
 */
const ERROR_PINS: ReadonlyArray<readonly [`0x${string}`, string]> = [
  ['0x1f2a2005', 'ZeroAmount'],
  ['0xd92e233d', 'ZeroAddress'],
  ['0x9d565d4e', 'MathOverflow'],
  ['0x8dd279dd', 'ProgramPaused'],
  ['0x7bfa4b9f', 'NotAdmin'],
  ['0xb5eba9f0', 'InvalidAdmin'],
  ['0x1b4f6bbd', 'NotRedeemer'],
  ['0x30cd7471', 'NotOwner'],
  ['0x2fab92ca', 'OwnershipCannotBeRenounced'],
  ['0x894b22ee', 'AdminChangeRequiresOwner'],
  ['0xa7d220e4', 'InvalidTakeRateBps'],
  ['0xc2700054', 'InvalidSplitBps'],
  ['0x68629813', 'InvalidSlashCapBps'],
  ['0x6537718f', 'InvalidVerifierDailyCap'],
  ['0x647c942e', 'InvalidMinimumStake'],
  ['0x3556ac58', 'MissingBeneficiary'],
  ['0x40f6b6ef', 'MissingRedeemer'],
  ['0xaa3a37a4', 'UnbondingPeriodTooShort'],
  ['0x6524596b', 'UnbondingPeriodTooLong'],
  ['0x645c50a3', 'VerifierRevoked'],
  ['0x12138258', 'VerifierAlreadyRevoked'],
  ['0x28a3411e', 'VerifierKeyExpired'],
  ['0xb42d0e00', 'VerifierNotRegistered'],
  ['0xabac01c8', 'VerifierAlreadyRegistered'],
  ['0xf2a25234', 'InvalidVerifierExpiry'],
  ['0x8baa579f', 'InvalidSignature'],
  ['0xf0ad0d09', 'MalleableSignature'],
  ['0xd38922ec', 'BadSignatureV'],
  ['0x790b2b9f', 'SignerIsNotPayer'],
  ['0xd6ce2e7a', 'SignerIsNotBuyer'],
  ['0x0819bdcd', 'SignatureExpired'],
  ['0x98edbdd3', 'SignatureDeadlineTooFar'],
  ['0x4bd574ec', 'BadNonce'],
  ['0x517f98f0', 'VoucherSeqZero'],
  ['0x7b2de8e8', 'VoucherSeqNotIncreasing'],
  ['0xfe1f88bd', 'VoucherSeqGapTooLarge'],
  ['0x157fd87e', 'VoucherExpired'],
  ['0x7ec15438', 'VoucherNotYetValid'],
  ['0x322f3b91', 'InvalidVoucherWindow'],
  ['0xdb9d3bca', 'VoucherLifetimeTooLong'],
  ['0x1ac9e02b', 'VoucherExceedsPerCallLimit'],
  ['0x8a9e6923', 'EscrowWindowLimitExceeded'],
  ['0x71de3750', 'EscrowInsufficient'],
  ['0x6b4ea0bb', 'EscrowLimitsUnchanged'],
  ['0x43ead8fa', 'ProviderBelowMinimumStake'],
  ['0x0b7d62e2', 'BatchTooLarge'],
  ['0x17e37b5c', 'BatchLengthMismatch'],
  ['0xc2e5347d', 'EmptyBatch'],
  ['0xeaad2a76', 'DelegateIsPayer'],
  ['0xf188d51a', 'DelegateCapsInvalid'],
  ['0x6a8b28b6', 'DelegateCapsExceedEscrowLimits'],
  ['0xede89bb7', 'DelegateValidUntilInvalid'],
  ['0xea843156', 'DelegationUnchanged'],
  ['0x13925a11', 'DelegateNotActive'],
  ['0x8c390496', 'TooManyDelegates'],
  ['0xa8a8247b', 'DelegateIsRevoked'],
  ['0x157f584a', 'DelegateIsExpired'],
  ['0x1ebdc3dd', 'DelegateVoucherExceedsPerCallLimit'],
  ['0x3ae67490', 'DelegateWindowLimitExceeded'],
  ['0x27aa2f48', 'WithdrawNotYetAvailable'],
  ['0x37c59471', 'NoWithdrawRequested'],
  ['0x4e0ff329', 'WithdrawDelayTooShort'],
  ['0xb0a6ea29', 'TransferAmountMismatch'],
  ['0xedd6fe2b', 'AssetDecimalsNotSix'],
  ['0x51e7d130', 'InsufficientBondedStake'],
  ['0xaf6311b4', 'InsufficientUnbondingStake'],
  ['0xb6c7f82e', 'UnbondingPeriodNotElapsed'],
  ['0x716dcc39', 'AttestationExpired'],
  ['0x519037c5', 'AttestationNotYetValid'],
  ['0xffab5c33', 'InvalidAttestationWindow'],
  ['0xd56697d0', 'StatusDoesNotSlash'],
  ['0x38fbeb34', 'NothingToSlash'],
  ['0xc7300280', 'SlashCapExceeded'],
  ['0x09c1eae5', 'PenaltyTooSmallToSplit'],
  ['0x4789b627', 'PenaltyExceedsMaximum'],
  ['0x5d2cbb98', 'SlashNotPending'],
  ['0x23b883c7', 'SlashAlreadyExists'],
  ['0xb3b45102', 'SlashNotYetExecutable'],
  ['0xa0057580', 'SlashExecutionWindowClosed'],
  ['0x15fbdbc2', 'SlashNotExpired'],
  // The dispute upgrade (D-19).
  ['0xb9a22a6a', 'NotSlashedProvider'],
  ['0x435a3cfe', 'DisputeWindowClosed'],
  ['0x0c7b2f65', 'SlashNotDisputed'],
  ['0xccb665a6', 'NotArbiter'],
  ['0xae170cc2', 'AddressBlocked'],
  ['0x9589cd8b', 'InvalidSlashDelay'],
  // a4f97ab and the audit fix round (audit E-9). Computed with viem's keccak
  // over `<Name>()`; every name is in the compiled X402Config/X402Stake/
  // X402Escrow ABIs of that commit.
  ['0xe048dc84', 'DisputeTimedOut'],
  ['0x6eccea65', 'SlashAlreadyDisputed'],
  ['0x6a3f467f', 'SlashWindowNotDrained'],
  ['0x64ce2c77', 'ArbiterCannotUnblock'],
  ['0xf0318500', 'InvalidArbiter'],
  // OpenZeppelin `Ownable2StepUpgradeable`, raised by X402Config's owner doors
  // (D-17). Parameterised: `cast sig 'OwnableUnauthorizedAccount(address)'`
  // and `cast sig 'OwnableInvalidOwner(address)'`.
  ['0x118cdaa7', 'OwnableUnauthorizedAccount'],
  ['0x1e4fbdf7', 'OwnableInvalidOwner'],
];

describe('the Errors.sol selector table', () => {
  it('has one entry per declared error and no collisions', () => {
    // 91 from Errors.sol plus OpenZeppelin's two Ownable errors.
    expect(EVM_ERROR_BY_SELECTOR.size).toBe(93);
    expect(ERROR_PINS).toHaveLength(93);
  });

  it.each(ERROR_PINS)('%s decodes to %s', (selector, name) => {
    // `${selector}0000` — a revert is the bare 4-byte selector, and this proves
    // the decoder reads the first four bytes rather than the whole payload.
    expect(evmErrorName(`${selector}0000`)).toBe(name);
  });

  it('carries exactly the pinned selectors, so no name can be added unpinned', () => {
    expect([...EVM_ERROR_BY_SELECTOR.keys()].sort()).toEqual(
      ERROR_PINS.map(([selector]) => selector).sort(),
    );
  });

  it('names an unrecognised selector rather than swallowing it', () => {
    // The non-vacuity control. Without it, `evmErrorName = () => 'NotRedeemer'`
    // passes every case above that happens to be NotRedeemer, and a constant
    // that returned any single pinned name would pass one of the 83.
    expect(evmErrorName('0xdeadbeef')).toBe('UNKNOWN_REVERT:0xdeadbeef');
    expect(evmErrorName('0xDEADBEEF')).toBe('UNKNOWN_REVERT:0xdeadbeef');
    expect(evmErrorName(null)).toBe('UNKNOWN_REVERT:none');
    expect(evmErrorName(undefined)).toBe('UNKNOWN_REVERT:none');
    expect(evmErrorName('0x')).toBe('UNKNOWN_REVERT:none');
  });

  it('never returns a name for something it did not recognise', () => {
    // The failure this exists to deny: an unnamed refusal reading as a success.
    // Every answer is either a pinned name or visibly an unknown.
    const pinned = new Set(ERROR_PINS.map(([, name]) => name));
    for (const data of ['0x00000000', '0xffffffff', '0x12345678', 'not-hex-at-all']) {
      const answer = evmErrorName(data);
      expect({ data, named: pinned.has(answer) }).toEqual({ data, named: false });
      expect(answer.startsWith('UNKNOWN_REVERT:')).toBe(true);
    }
  });
});
