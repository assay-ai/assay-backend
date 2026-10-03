import { AbiParameter, toFunctionSelector } from 'viem';

import { EVM_ERROR_BY_SELECTOR, evmErrorName } from '@modules/chains/evm/abi/error-selectors';
import {
  ERC20_ABI,
  X402_CONFIG_ABI,
  X402_ESCROW_ABI,
  X402_STAKE_ABI,
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
 * - the 71 error selectors come from `cast sig '<Name>()'` on the pinned
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
];

const CONFIG_PINS: readonly Pin[] = [
  [
    '0xcff0ab96',
    'params()',
    '((address treasury,address redeemer,uint64 unbondingPeriodSeconds,uint64 minimumStake,uint64 penaltyAmount,uint64 verifierDailyCap,uint16 takeRateBps,uint16 slashAgentBps,uint16 slashPlatformBps,uint16 slashCapBps))',
  ],
  ['0x5c975abb', 'paused()', '(bool)'],
  ['0xf851a440', 'admin()', '(address)'],
  ['0x5a6d11bb', 'slashProviderBps()', '(uint16)'],
  ['0x7ef30520', 'canSign(address)', '(bool)'],
  ['0x7e0625bd', 'verifierExpiry(address)', '(uint64)'],
  [
    '0x4d44b5b7',
    'verifierKey(address)',
    '((uint64 registeredAt,uint64 expiresAt,uint64 revokedAt,bool registered,bool revoked))',
  ],
];

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
    '((address provider,uint8 status,uint64 penalty,address beneficiary,uint64 proposedAt,uint32 __gap,address verifier,uint64 executableAt,uint32 __gap2,uint64 reserved,uint64 capAllowance,uint64 applied,uint64 executedAt,bytes32 policy))',
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

const SUITES = [
  ['escrow', X402_ESCROW_ABI, ESCROW_PINS],
  ['config', X402_CONFIG_ABI, CONFIG_PINS],
  ['stake', X402_STAKE_ABI, STAKE_PINS],
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

  it('vendors no writer the admin ledger owns, by name', () => {
    // Belt and braces over the selector check above, and the one that reads as
    // an instruction to a future editor rather than as a hash comparison.
    const names: readonly string[] = [...X402_CONFIG_ABI, ...X402_STAKE_ABI, ...X402_ESCROW_ABI]
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
    ]) {
      expect({ forbidden, vendored: names.includes(forbidden) }).toEqual({
        forbidden,
        vendored: false,
      });
    }
  });
});

/**
 * Every `error X();` in `assay-evm/src/Errors.sol`, name and selector.
 *
 * The names were extracted mechanically from the Solidity
 * (`grep -oE '^\s*error\s+([A-Za-z0-9_]+)\s*\(\s*\)\s*;'` → 71 hits, and the
 * complementary grep for a non-zero-argument error returned nothing). Each
 * selector is `cast sig '<Name>()'` on the pinned Foundry build.
 *
 * All 71 are pinned rather than a sample: pinning four leaves 67 names free to
 * be misspelled, and a misspelled name produces a selector that no revert will
 * ever carry — so the table reports `UNKNOWN_REVERT` for a refusal it was
 * written to name, and no test notices.
 */
const ERROR_PINS: ReadonlyArray<readonly [`0x${string}`, string]> = [
  ['0x1f2a2005', 'ZeroAmount'],
  ['0xd92e233d', 'ZeroAddress'],
  ['0x679346bc', 'AmountExceedsUint64'],
  ['0x9d565d4e', 'MathOverflow'],
  ['0x8dd279dd', 'ProgramPaused'],
  ['0x7bfa4b9f', 'NotAdmin'],
  ['0xb5eba9f0', 'InvalidAdmin'],
  ['0x1b4f6bbd', 'NotRedeemer'],
  ['0x472e017e', 'NotBuyer'],
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
  ['0xff20078c', 'SignerIsNotVerifier'],
  ['0xd6ce2e7a', 'SignerIsNotBuyer'],
  ['0x0819bdcd', 'SignatureExpired'],
  ['0x4bd574ec', 'BadNonce'],
  ['0x517f98f0', 'VoucherSeqZero'],
  ['0x7b2de8e8', 'VoucherSeqNotIncreasing'],
  ['0x157fd87e', 'VoucherExpired'],
  ['0x7ec15438', 'VoucherNotYetValid'],
  ['0x322f3b91', 'InvalidVoucherWindow'],
  ['0xdb9d3bca', 'VoucherLifetimeTooLong'],
  ['0x1ac9e02b', 'VoucherExceedsPerCallLimit'],
  ['0x8a9e6923', 'EscrowWindowLimitExceeded'],
  ['0x71de3750', 'EscrowInsufficient'],
  ['0x6b4ea0bb', 'EscrowLimitsUnchanged'],
  ['0xd64c40ff', 'EscrowLimitsRequireBuyer'],
  ['0x43ead8fa', 'ProviderBelowMinimumStake'],
  ['0x0b7d62e2', 'BatchTooLarge'],
  ['0x17e37b5c', 'BatchLengthMismatch'],
  ['0xc2e5347d', 'EmptyBatch'],
  ['0x27aa2f48', 'WithdrawNotYetAvailable'],
  ['0x37c59471', 'NoWithdrawRequested'],
  ['0x4e0ff329', 'WithdrawDelayTooShort'],
  ['0xb0a6ea29', 'TransferAmountMismatch'],
  ['0x6f8a66c9', 'Permit2NotConfigured'],
  ['0xedd6fe2b', 'AssetDecimalsNotSix'],
  ['0x88b36cc1', 'DestinationIsVault'],
  ['0x51e7d130', 'InsufficientBondedStake'],
  ['0xaf6311b4', 'InsufficientUnbondingStake'],
  ['0xb6c7f82e', 'UnbondingPeriodNotElapsed'],
  ['0x716dcc39', 'AttestationExpired'],
  ['0x519037c5', 'AttestationNotYetValid'],
  ['0xffab5c33', 'InvalidAttestationWindow'],
  ['0xd56697d0', 'StatusDoesNotSlash'],
  ['0x38fbeb34', 'NothingToSlash'],
  ['0xc7300280', 'SlashCapExceeded'],
  ['0x7c2fa623', 'VerifierDailyCapExceeded'],
  ['0x09c1eae5', 'PenaltyTooSmallToSplit'],
  ['0x4789b627', 'PenaltyExceedsMaximum'],
  ['0x5d2cbb98', 'SlashNotPending'],
  ['0x23b883c7', 'SlashAlreadyExists'],
  ['0xb3b45102', 'SlashNotYetExecutable'],
  ['0xa0057580', 'SlashExecutionWindowClosed'],
  ['0x15fbdbc2', 'SlashNotExpired'],
];

describe('the Errors.sol selector table', () => {
  it('has one entry per declared error and no collisions', () => {
    expect(EVM_ERROR_BY_SELECTOR.size).toBe(71);
    expect(ERROR_PINS).toHaveLength(71);
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
    // that returned any single pinned name would pass one of the 71.
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
