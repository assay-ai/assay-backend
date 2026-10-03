import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import {
  AccountId,
  AssetId,
  ChainId,
  chainIdOf,
  isAccountId,
  namespaceOf,
  parseAssetId,
  toAssetId,
} from '@modules/chains/ports/caip.types';
import { ChainAdapter } from '@modules/chains/ports/chain-adapter.port';
import { Money } from '@modules/chains/ports/money.types';
import { PayoutProofChallenge } from '@modules/chains/ports/payout-proof.types';
import { StakeAuthorityChallenge } from '@modules/chains/ports/stake-authority.types';
import {
  BuildRequirementsInput,
  ObservedTransfer,
  PaymentIntent,
  PaymentPayload,
  SettlementReceipt,
  TxRef,
  Voucher,
} from '@modules/chains/ports/x402.types';
import { BaseError } from '@shared/errors/base.error';
import { MoneyErrorCode } from '@shared/errors/money.errors';
import { MoneyUtil } from '@utils/money.util';

/**
 * The contract every `ChainAdapter` must satisfy — run against all of them, not
 * written once per chain. Implements a numbered list of 22 adapter properties,
 * and every assertion below carries the number it implements.
 *
 * ## Why this file exists
 *
 * A chain-adapter contract suite was promised from the first chain port
 * onward, and it never existed. With both chains production-grade, in
 * parallel, that is not acceptable: the EVM adapter is the only thing standing
 * between the domain and a second chain, and with one implementation the port is untested by
 * construction. The first real second backend is where you find out which of
 * the port's guarantees were accidents of the first one.
 *
 * Same arrangement as `test/unit/verification/signing/signer-port.contract.ts`,
 * which two `SignerPort` implementations already run. This file is a `.ts` and
 * not a `.spec.ts` on purpose: jest's `testRegex` is `test/unit/.*\.spec\.ts$`,
 * so a library is not collected as a suite of its own.
 *
 * ## What a fixture may and may not be
 *
 * {@link ChainAdapterFixtures} is the ONLY chain-specific input. Everything
 * asserted below is a chain-agnostic *property* — never a behaviour, never a
 * literal. An assertion that names base58, `0x`, 88 characters or a genesis
 * hash belongs in that adapter's own spec, not here: this suite has to be
 * satisfiable by a chain nobody has written yet.
 *
 * ## Reading this suite adversarially
 *
 * A conformance suite is only worth what its weakest assertion is worth, and
 * the failure mode is never a wrong implementation — it is an assertion that
 * asserts less than its name claims. Two habits here are deliberate and should
 * be kept:
 *
 *  - **Every "must refuse X" has a positive control next to it.** A validator
 *    that returns `false` for everything satisfies assertion 3 as
 *    written; the control is what stops it.
 *  - **Nothing is asserted that the fixture itself supplied.** Where a
 *    precondition on the fixture is genuinely needed (the amount must be
 *    non-zero for "below the intent" to exist), it is stated as a precondition
 *    and labelled as one, not counted as coverage of the adapter.
 *  - **"A chain this adapter does not serve" means two different things**, and
 *    both are probed: a chain in another namespace, and a chain in this
 *    adapter's OWN namespace that is not in `supportedChains`. Only the second
 *    can see a guard written as namespace equality — which is the exact
 *    fail-open `enabled-chains.ts` and `solana-chain.adapter.ts:107-115` exist
 *    to memorialise ("a devnet deployment reconciling mainnet forever").
 *
 * ## What this suite CANNOT see, and where the cover has to come from instead
 *
 * Written down because an undocumented limit reads, three months later, exactly
 * like coverage. Each of these was reached by writing the degenerate adapter
 * that survives it.
 *
 *  - **It cannot tell a keyed signature from a public checksum.** Every signing
 *    assertion is a consistency check between `build`, `verify` and a signature
 *    the fixture supplied, so `verify = (v, sig, signer) => sig === sha256(tag
 *    | JSON(v) | signer)` — forgeable by anyone, no secret anywhere — passes
 *    them all. Requiring a SECOND key holder's genuine signature (below) kills
 *    the family that ignores the signer, and nothing available to a black-box
 *    contract kills the rest. The adapter's own spec is where real cryptography
 *    is pinned: `solana-chain.adapter.spec.ts` signs with `node:crypto`
 *    ed25519 and asserts an attacker's genuine signature does not verify.
 *  - **It cannot tell a binding read out of a SIGNED transaction from a boolean
 *    the client sent.** `chain-adapter.port.ts` and `SolanaChainAdapter`'s own
 *    docstring both say an echoed memo proves nothing — but `bound: true` in
 *    the payload is a legal opaque payload, so assertion 9's pair is satisfied
 *    by `if (payload.payload.bound !== true) throw`. Whether the binding is
 *    signed is a property of the chain's payload format, which this file is
 *    forbidden from knowing.
 *  - **It cannot demand `getVaultAccount(owner) !== owner`.** On an
 *    account-model chain the ERC-20 balance holder IS the owner's address, so
 *    the identity function is correct there. See assertion 21's control for the
 *    weaker property that IS chain-agnostic.
 *  - **`buildPaymentRequirements`'s `amount` and `extractSettledAmount`'s
 *    return are pass-through.** Echoing is the correct behaviour, so no fixture
 *    can separate "echoes correctly" from "echoes". What the two assertions do
 *    catch is rescaling, rounding, emitting a decimal, and substituting the
 *    intent amount for the observed one.
 *
 * ## One ordering constraint on the next adapter
 *
 * `getAssetMetadata(fixtures.requirementsInput.amount.asset)` throws for an
 * asset that is not in `asset-registry.ts`, which today holds only Solana
 * USDC. So `eip155-adapter.contract.spec.ts` cannot be written until the
 * registry gains an EVM entry — while `registry-coverage.spec.ts` demands that
 * spec the moment `ChainNamespace.EIP155` acquires an adapter. Add the registry
 * entry first.
 */
export interface ChainAdapterFixtures {
  /** A chain this adapter serves. */
  readonly chainId: ChainId;
  /**
   * A SECOND chain this adapter serves, different from {@link chainId}.
   *
   * Assertion 10 — "throws when the payload's network is not the
   * intent's chain" — is about a comparison, and a foreign-namespace chain id
   * never reaches it: the adapter's own "do I serve this?" guard fires first.
   * Deleting that comparison from the reference adapter left the whole 3,535-
   * test unit suite green. This field is what makes the comparison the only
   * thing that can refuse the payload.
   */
  readonly servedOtherChainId: ChainId;
  /** A well-formed chain id from a DIFFERENT namespace. Every method must refuse it. */
  readonly otherNamespaceChainId: ChainId;
  /**
   * A well-formed chain id in THIS adapter's namespace that it does not serve.
   *
   * Assertion 22 says "outside `supportedChains`", not "outside the
   * namespace". Probed only with the latter, an adapter whose guard is
   * `namespaceOf(chainId) === this.namespace` passes every case — a devnet
   * deployment that quietly serves mainnet, which is the incident
   * `ENABLED_CHAINS` exists because of.
   */
  readonly unservedSameNamespaceChainId: ChainId;
  readonly validAddress: string;
  /** Well-formed as a string, invalid as an address on this chain. */
  readonly invalidAddress: string;
  readonly asset: AssetId;
  readonly voucher: Voucher;
  readonly voucherSignature: string;
  readonly voucherSigner: AccountId;
  readonly payoutChallenge: PayoutProofChallenge;
  readonly payoutSignature: string;
  readonly payoutSigner: AccountId;
  readonly stakeChallenge: StakeAuthorityChallenge;
  readonly stakeSignature: string;
  readonly stakeSigner: AccountId;
  /**
   * A SECOND key holder, and its genuine signatures over the same three values.
   *
   * Every other signing assertion is a consistency check the fixture itself
   * closes, so `verify` keyed to one hardcoded signature, or to one hardcoded
   * signer, passes. These force the fixture to hold two independent secrets and
   * require the adapter to tell them apart in both directions.
   *
   * They do NOT establish that the scheme is cryptographic — see "What this
   * suite CANNOT see" above.
   */
  readonly secondSigner: AccountId;
  readonly voucherSignatureBySecondSigner: string;
  readonly payoutSignatureBySecondSigner: string;
  readonly stakeSignatureBySecondSigner: string;
  readonly intent: PaymentIntent;
  /** A payload that IS bound to `intent`. */
  readonly boundPayload: PaymentPayload;
  /** A payload that is NOT bound to `intent`. */
  readonly unboundPayload: PaymentPayload;
  readonly requirementsInput: BuildRequirementsInput;
  /**
   * A transaction the adapter's chain reader CAN find, paying `intent.payTo`.
   *
   * Not in the numbered list's fixtures, and added because assertion 14 is unkillable
   * without it: "returns `null` for an unknown reference" is satisfied in full
   * by `observeTransfer = async () => null`, which is also the shape of every
   * real bug this method can have. The positive case is the control that makes
   * the null case mean something.
   *
   * **Two obligations on whoever writes this fixture**, because the suite can
   * check the second but not the first:
   *
   *  1. The backing reader must compute {@link settledTransfer} from a NON-ZERO
   *     opening balance, so that an adapter reporting the post-transaction
   *     balance instead of the delta fails. (The Solana fixture uses 1000 →
   *     4200 for a delta of 3200.)
   *  2. The same transaction observed for a DIFFERENT payee must not report
   *     this transfer. The suite asserts that, and it is what stops
   *     `observeTransfer` returning a constant the fixture also supplies.
   */
  readonly settledTransaction: TxRef;
  /** Exactly what {@link settledTransaction} moved — the delta, not a balance. */
  readonly settledTransfer: ObservedTransfer;
  /** Well-formed as a reference, unknown to the chain reader. */
  readonly unknownTransaction: TxRef;
}

/**
 * How "this adapter does not serve that chain" is allowed to be spelled.
 *
 * Assertion 22 names `CHAIN_UNSUPPORTED`. The reference adapter throws
 * `CHAIN_NAMESPACE_MISMATCH` — `SolanaChainAdapter.assertServes` — and has
 * from the start; `CHAIN_UNSUPPORTED` is what `ChainAdapterRegistry` raises when
 * no adapter claims the chain at all. Both are 400s naming the chain, and the
 * distinction is which layer noticed.
 *
 * Accepting either is a deliberate weakening of assertion 22, recorded rather
 * than hidden: narrowing it to `CHAIN_UNSUPPORTED` would mean changing the
 * Solana adapter's behaviour, which this suite was introduced without. It is
 * still a real check — the set excludes every other `CHAIN_*` code, so an
 * adapter that fails a foreign chain id with `CHAIN_PAYLOAD_MALFORMED`, or with
 * a `TypeError` from a chain SDK, does not pass.
 */
const REFUSES_A_FOREIGN_CHAIN: readonly string[] = [
  ChainErrorCode.CHAIN_UNSUPPORTED,
  ChainErrorCode.CHAIN_NAMESPACE_MISMATCH,
];

/**
 * The methods assertion 22 is run against.
 *
 * `extractSettledAmount` joined this list with the EVM adapter. It takes a
 * `PaymentIntent`, so it has a chain id, and before then it guarded on neither that nor
 * `receipt.network` — the entry here used to say "whoever widens this list is
 * the person who should add BOTH", and they did, on both adapters, in the
 * change that added this line. The second guard is not covered by assertion 22
 * at all (a foreign chain id is refused by the first), and lives in each
 * adapter's own behaviour spec, which is where a receipt from one SERVED chain
 * can be presented against an intent on another.
 *
 * TWO members remain deliberately absent, and the absence is written here
 * rather than left as a gap in a list nobody re-reads:
 *
 *  - `buildPayoutProofMessage` / `buildStakeAuthorityMessage` — pure encoders
 *    over a challenge whose `account` names a chain. The reference adapter
 *    encodes the string without parsing it. The *verify* half of each pair IS
 *    in this list, which is where the guard is load-bearing: a foreign signer
 *    is refused before any signature is checked.
 */
const CHAIN_SCOPED_METHODS = [
  'isValidAddress',
  'toAccountId',
  'parseAccountId',
  'buildPaymentRequirements',
  'assertPayloadBoundToIntent',
  'extractSettledAmount',
  'observeTransfer',
  'getVaultAccount',
  'getVaultBalance',
  'buildVoucherMessage',
  'verifyVoucherSignature',
  'verifyPayoutProofSignature',
  'verifyStakeAuthoritySignature',
] as const;

type ChainScopedMethod = (typeof CHAIN_SCOPED_METHODS)[number];

/** Runs `fn`, requires it to have thrown an `AppError`, and returns its code. */
const codeOf = async (fn: () => unknown): Promise<string> => {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error('expected a throw; the call returned normally');
  }
  // A chain SDK's own `TypeError` is not a refusal — it is the 500-with-a-stack
  // -trace this port exists to convert into a 400.
  expect(thrown).toBeInstanceOf(BaseError);
  return (thrown as BaseError).errorCode;
};

const HEX_DIGITS = '0123456789abcdef';
const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';

function isMoney(value: unknown): value is Money {
  return (
    typeof value === 'object' &&
    value !== null &&
    'amount' in value &&
    'asset' in value &&
    'decimals' in value
  );
}

/**
 * A different account on the same chain, drawn from the fixtures themselves.
 *
 * Mutating a CAIP-10 field by appending a character does not work: the result
 * is not an address on any chain, so the encoder throws instead of encoding
 * something different, and the mutation test fails for the wrong reason. The
 * substitute has to be a genuinely valid account, which only the fixture can
 * supply — hence a pool rather than a synthesised value.
 */
function otherAccountThan(
  current: AccountId,
  pool: readonly AccountId[],
  alsoAvoid: readonly AccountId[] = [],
): AccountId {
  const chain = chainIdOf(current);
  const other = pool.find(
    (candidate) =>
      candidate !== current && !alsoAvoid.includes(candidate) && chainIdOf(candidate) === chain,
  );
  if (!other) {
    throw new Error(`fixtures supply no second account on ${chain} to mutate "${current}" into`);
  }
  return other;
}

/**
 * Changes a string into a different one of the SAME shape.
 *
 * Shape-preserving on purpose. A voucher's `requestHash` is `sha256:` plus 64
 * lower-case hex; a `seq` is a decimal `u64`; a signature is base58 or hex.
 * Appending `'x'` to any of them produces a value the encoder rejects, and a
 * rejected mutation proves nothing about whether the field is inside the signed
 * bytes. Rotating the final character within its own alphabet keeps every one
 * of those grammars intact.
 */
function mutateString(value: string, accounts: readonly AccountId[]): string {
  if (isAccountId(value)) {
    return otherAccountThan(value as AccountId, accounts);
  }
  if (value === '') {
    return 'x';
  }
  if (/^\d+$/.test(value)) {
    return (BigInt(value) + 1n).toString();
  }
  const last = value.slice(-1);
  const alphabet = HEX_DIGITS.includes(last) ? HEX_DIGITS : ALPHANUMERIC;
  const index = alphabet.indexOf(last);
  const next = alphabet[(index + 1) % alphabet.length];
  return `${value.slice(0, -1)}${next}`;
}

/** One field changed, everything else identical. Throws rather than guessing. */
function mutateField<T extends object>(
  value: T,
  field: keyof T & string,
  accounts: readonly AccountId[],
): T {
  const current = value[field];
  let mutated: unknown;
  if (typeof current === 'number') {
    mutated = current + 1;
  } else if (isMoney(current)) {
    mutated = { ...current, amount: (BigInt(current.amount) + 1n).toString() };
  } else if (typeof current === 'string') {
    mutated = mutateString(current, accounts);
  } else {
    throw new Error(`no mutation strategy for field "${field}" of type ${typeof current}`);
  }
  return { ...value, [field]: mutated } as T;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * A signed structure and the pair of adapter methods that build and check it.
 *
 * Assertions 15–18 are written about the voucher and assertion 19 says
 * "the same three for `verifyPayoutProofSignature` and
 * `verifyStakeAuthoritySignature`". Running one parameterised block over all
 * three is what makes "the same" true by construction rather than by three
 * hand-copied blocks that drift.
 */
interface SignedStructure<T extends object> {
  readonly label: string;
  readonly value: T;
  readonly signature: string;
  readonly signer: AccountId;
  /** The same value, signed by a genuinely different key holder. */
  readonly alternateSignature: string;
  readonly alternateSigner: AccountId;
  readonly build: (value: T) => Uint8Array;
  readonly verify: (value: T, signature: string, signer: AccountId) => boolean;
}

function describeSignedStructure<T extends object>(
  structure: SignedStructure<T>,
  accounts: readonly AccountId[],
): void {
  const { label, value, signature, signer, alternateSignature, alternateSigner, build, verify } =
    structure;
  const fields = Object.keys(value) as (keyof T & string)[];

  // 15
  it(`${label}: builds the same non-empty bytes twice for the same input`, () => {
    const first = build(value);
    const second = build({ ...value });
    // Non-emptiness is not decoration: `() => new Uint8Array()` is deterministic
    // and would otherwise satisfy this outright.
    expect(first.length).toBeGreaterThan(0);
    expect(hex(second)).toBe(hex(first));
  });

  // 16
  it.each(fields)(`${label}: builds different bytes when %s is mutated`, (field) => {
    const original = build(value);
    const mutated = build(mutateField(value, field, accounts));
    expect(hex(mutated)).not.toBe(hex(original));
  });

  // 17 / 19 — the positive case, which is also the control for every
  // `toBe(false)` below: without it, `verify = () => false` passes them all.
  it(`${label}: verifies the signature the fixture actually produced`, () => {
    expect(verify(value, signature, signer)).toBe(true);
  });

  // 17 / 19 — a mutated payload, over every field rather than a chosen one.
  it.each(fields)(`${label}: refuses the signature once %s is mutated`, (field) => {
    expect(verify(mutateField(value, field, accounts), signature, signer)).toBe(false);
  });

  // 17 / 19 — a mutated signature.
  it(`${label}: refuses a signature altered by one character`, () => {
    expect(verify(value, mutateString(signature, accounts), signer)).toBe(false);
  });

  // 17 / 19 — a different signer.
  it(`${label}: refuses a genuine signature attributed to a different signer`, () => {
    expect(verify(value, signature, otherAccountThan(signer, accounts))).toBe(false);
  });

  // 17 / 19 — a SECOND key holder over the SAME value. Kills a `verify` keyed
  // to one hardcoded signature, and one keyed to a single hardcoded signer.
  it(`${label}: verifies a second key holder over the same value, with different bytes`, () => {
    expect(alternateSigner).not.toBe(signer);
    // Two independent secrets over identical bytes must not produce identical
    // signatures — that is the cheapest observable difference between "signed"
    // and "derived from public inputs the same way twice".
    expect(alternateSignature).not.toBe(signature);
    expect(verify(value, alternateSignature, alternateSigner)).toBe(true);
  });

  it(`${label}: refuses each key holder's signature under the other's account`, () => {
    expect(verify(value, alternateSignature, signer)).toBe(false);
    expect(verify(value, signature, alternateSigner)).toBe(false);
  });

  // 18 / 19 — malformed input answers the question asked, it does not blow up.
  //
  // Three shapes rather than one because WHICH of them reaches a decoder that
  // throws is chain-specific: on the reference adapter only
  // `'not-a-signature'` does (base58 decoding of `''` and `'AAAA'` succeeds and
  // the verification simply fails), so on Solana the other two are duplicates
  // of "a wrong signature". On a chain whose decoder throws for a short or
  // empty input, a different one of the three carries the assertion. Keeping
  // all three is what makes the case portable; do not prune it to the one that
  // happens to bite here.
  it.each([
    ['the empty string', ''],
    ['a string that is not an encoded signature', 'not-a-signature'],
    ['a signature of the wrong length', 'AAAA'],
  ])(`${label}: returns false rather than throwing for %s`, (_case, malformed) => {
    let result: unknown;
    expect(() => {
      result = verify(value, malformed, signer);
    }).not.toThrow();
    expect(result).toBe(false);
  });
}

export function describeChainAdapterContract(
  name: string,
  factory: () => ChainAdapter | Promise<ChainAdapter>,
  fixtures: ChainAdapterFixtures,
): void {
  describe(`${name} satisfies the ChainAdapter contract`, () => {
    let adapter: ChainAdapter;

    /**
     * Every CAIP-10 the fixtures name, deduplicated.
     *
     * The mutation helpers draw substitute accounts from here — see
     * {@link otherAccountThan} for why a synthesised one cannot work.
     */
    const accounts: readonly AccountId[] = [
      ...new Set<AccountId>([
        fixtures.voucher.payer,
        fixtures.voucher.payTo,
        fixtures.voucher.provider,
        fixtures.voucherSigner,
        fixtures.payoutChallenge.account,
        fixtures.payoutSigner,
        fixtures.stakeChallenge.account,
        fixtures.stakeSigner,
        fixtures.secondSigner,
        fixtures.intent.payTo,
        fixtures.requirementsInput.payTo,
        fixtures.requirementsInput.payer,
        fixtures.requirementsInput.feePayer,
      ]),
    ];

    /** A well-formed CAIP-10 on a chain in another namespace. */
    const foreignAccount =
      `${fixtures.otherNamespaceChainId}:${fixtures.validAddress}` as AccountId;

    beforeEach(async () => {
      adapter = await factory();
    });

    it('the fixtures themselves are usable (precondition, not coverage)', () => {
      // Stated so that a fixture defect reads as a fixture defect. None of this
      // is a property of the adapter and none of it is counted as one.
      expect(namespaceOf(fixtures.otherNamespaceChainId)).not.toBe(namespaceOf(fixtures.chainId));
      expect(accounts.length).toBeGreaterThanOrEqual(2);
      expect(BigInt(fixtures.intent.amount.amount)).toBeGreaterThan(0n);
      expect(fixtures.requirementsInput.amount.decimals).toBe(
        getAssetMetadata(fixtures.requirementsInput.amount.asset).decimals,
      );
      // `buildPaymentRequirements`' `payTo` assertion below derives the vault
      // account; a fixture that pre-derived it would be asserting a different
      // property (see `BuildRequirementsInput.payToIsTokenAccount`).
      expect(fixtures.requirementsInput.payToIsTokenAccount ?? false).toBe(false);
      // The two "not this chain" fixtures have to be genuinely different
      // things, or assertion 22 collapses back to a namespace check.
      expect(fixtures.servedOtherChainId).not.toBe(fixtures.chainId);
      expect(adapter.supportedChains).toContain(fixtures.servedOtherChainId);
      expect(namespaceOf(fixtures.unservedSameNamespaceChainId)).toBe(
        namespaceOf(fixtures.chainId),
      );
      expect(adapter.supportedChains).not.toContain(fixtures.unservedSameNamespaceChainId);
    });

    // ── Identity ─────────────────────────────────────────────────────────

    // 1
    it('reports a namespace that every entry in supportedChains shares', () => {
      expect(adapter.supportedChains.length).toBeGreaterThan(0);
      for (const chainId of adapter.supportedChains) {
        expect(namespaceOf(chainId)).toBe(adapter.namespace);
      }
    });

    // 2
    it('has a non-empty supportedChains free of duplicates, containing the fixture chain', () => {
      expect(adapter.supportedChains.length).toBeGreaterThan(0);
      expect(new Set(adapter.supportedChains).size).toBe(adapter.supportedChains.length);
      expect(adapter.supportedChains).toContain(fixtures.chainId);
    });

    // 3 — the control. Assertions 3's four negatives are all satisfied by
    // `isValidAddress = () => false`, which is why this one comes first.
    it('accepts an address that IS valid on this chain', () => {
      expect(adapter.isValidAddress(fixtures.chainId, fixtures.validAddress)).toBe(true);
    });

    // 3 - the trailing-newline case is built from `validAddress`, so the only
    // difference from a value this adapter just accepted is one byte.
    it.each([
      ['the empty string', ''],
      ['a 1,000-character string', 'a'.repeat(1000)],
      ['a trailing newline', `${fixtures.validAddress}\n`],
    ])('rejects %s as an address', (_label, candidate) => {
      expect(adapter.isValidAddress(fixtures.chainId, candidate)).toBe(false);
    });

    // 3
    it("rejects the other namespace's valid address", () => {
      // The one case a permissive validator passes: a string that IS a valid
      // address, just not here.
      expect(adapter.isValidAddress(fixtures.chainId, fixtures.invalidAddress)).toBe(false);
    });

    // 3/4 coherence, beyond the numbered list — an account this adapter will PARSE must
    // contain an address it considers VALID.
    //
    // Assertion 3 checks one valid address and four invalid ones, which
    // a validator that knows exactly one string satisfies. Two port methods
    // disagreeing about the same address is a real defect and the only
    // chain-agnostic lever on that degenerate: the fixture already has to name
    // several accounts, and every one of them is an address this adapter has
    // committed to parsing.
    it('considers every address it parses out of a fixture account valid', () => {
      const onThisChain = accounts.filter((account) => chainIdOf(account) === fixtures.chainId);
      expect(onThisChain.length).toBeGreaterThanOrEqual(2);
      for (const account of onThisChain) {
        const { address } = adapter.parseAccountId(account);
        expect(adapter.isValidAddress(fixtures.chainId, address)).toBe(true);
      }
    });

    // 4
    it('round-trips toAccountId through parseAccountId to the same pair', () => {
      const accountId = adapter.toAccountId(fixtures.chainId, fixtures.validAddress);
      expect(isAccountId(accountId)).toBe(true);
      expect(adapter.parseAccountId(accountId)).toEqual({
        chainId: fixtures.chainId,
        address: fixtures.validAddress,
      });
    });

    // 5
    it('throws CHAIN_INVALID_ADDRESS rather than returning a malformed AccountId', async () => {
      // The failure mode this rules out is a `toAccountId` that concatenates
      // and returns. A malformed AccountId that type-checks travels all the way
      // to an RPC call, where the error is a 500 with a chain SDK stack trace.
      expect(
        await codeOf(() => adapter.toAccountId(fixtures.chainId, fixtures.invalidAddress)),
      ).toBe(ChainErrorCode.CHAIN_INVALID_ADDRESS);
    });

    // 6
    it('throws when parseAccountId is given a chain id from another namespace', async () => {
      expect(REFUSES_A_FOREIGN_CHAIN).toContain(
        await codeOf(() => adapter.parseAccountId(foreignAccount)),
      );
    });

    // ── x402 requirements ────────────────────────────────────────────────

    // 7
    it('returns requirements whose network is the requested chain', async () => {
      const requirements = await adapter.buildPaymentRequirements(fixtures.requirementsInput);
      expect(requirements.network).toBe(fixtures.requirementsInput.chainId);
    });

    // 7, and beyond the numbered list — everything else `buildPaymentRequirements` returns.
    //
    // The list names only `network` and `amount`, which leaves `payTo` — the
    // chain-native address the buyer's money is actually sent to — asserted by
    // nothing at all. An adapter advertising an attacker's address was
    // conformant. `payTo` is pinned against a value the FIXTURE does not
    // supply: it is recomputed here from `getVaultAccount`, so the check
    // composes two port methods instead of comparing a constant to itself.
    it('advertises the derived vault account, the asked-for asset and resource', async () => {
      const input = fixtures.requirementsInput;
      const requirements = await adapter.buildPaymentRequirements(input);

      const vault = await adapter.getVaultAccount(input.payTo, input.amount.asset);
      expect(requirements.payTo).toBe(adapter.parseAccountId(vault).address);
      expect(requirements.asset).toBe(parseAssetId(input.amount.asset).assetReference);
      expect(requirements.resource).toBe(input.resource);
      // A scheme is what the client answers with, so the advertised one and the
      // one on a payload this adapter accepts as bound cannot differ.
      expect(requirements.scheme.length).toBeGreaterThan(0);
      expect(requirements.scheme).toBe(fixtures.boundPayload.scheme);
      // Zero means "already expired", which is not an offer.
      expect(requirements.maxTimeoutSeconds).toBeGreaterThan(0);
    });

    // 8
    it('returns an atomic amount MoneyUtil accepts at the registry scale', async () => {
      const requirements = await adapter.buildPaymentRequirements(fixtures.requirementsInput);
      const metadata = getAssetMetadata(fixtures.requirementsInput.amount.asset);

      // x402 requires atomic units, never a decimal — so the advertised string
      // must be the input's atomic units unchanged. Asserting only that
      // `MoneyUtil` accepts it would pass for an adapter that advertised a
      // different number, and asserting only `decimals` would be an assertion
      // about the fixture.
      expect(requirements.amount).toMatch(/^\d+$/);
      expect(BigInt(requirements.amount)).toBe(
        MoneyUtil.toAtomic(fixtures.requirementsInput.amount),
      );
      expect(() =>
        MoneyUtil.of(
          requirements.amount,
          fixtures.requirementsInput.amount.asset,
          metadata.decimals,
        ),
      ).not.toThrow();
    });

    // ── Payload binding ──────────────────────────────────────────────────

    // 9
    it('returns void for a bound payload and THROWS for an unbound one — never a boolean', async () => {
      const accepted: unknown = adapter.assertPayloadBoundToIntent(
        fixtures.boundPayload,
        fixtures.intent,
      );
      // `undefined`, not `false`: a method that answered with a boolean would
      // be forgettable at the call site, which is the whole reason this one
      // throws. `toBeUndefined()` alone would also pass for a `void` method
      // that accepted everything — the refusal below is what pairs with it.
      expect(accepted).toBeUndefined();

      // The code is the port's own vocabulary, not Solana's: the fixture
      // promises `unboundPayload` is WELL-FORMED and bound to something else,
      // so `CHAIN_PAYLOAD_MALFORMED` would be the wrong answer to this and is
      // deliberately not accepted here.
      expect(
        await codeOf(() =>
          adapter.assertPayloadBoundToIntent(fixtures.unboundPayload, fixtures.intent),
        ),
      ).toBe(ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT);
    });

    // 10
    // The payload is on a chain this adapter DOES serve, just not the intent's.
    // That is the only way to reach the comparison: with a foreign-NAMESPACE
    // payload the adapter's "do I serve this?" guard fires first, and the case
    // then passes for an adapter with no cross-chain binding check at all —
    // measured, deleting the comparison left all 3,535 unit tests green. The
    // code is pinned exactly for the same reason.
    it("throws when the payload's network is not the intent's chain", async () => {
      const otherChain = { ...fixtures.boundPayload, network: fixtures.servedOtherChainId };
      expect(
        await codeOf(() => adapter.assertPayloadBoundToIntent(otherChain, fixtures.intent)),
      ).toBe(ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT);
    });

    // ── Settled amount ───────────────────────────────────────────────────

    const receiptOf = (observed: ObservedTransfer): SettlementReceipt => ({
      transaction: fixtures.settledTransaction,
      network: fixtures.intent.chainId,
      payer: fixtures.voucherSigner,
      observed,
    });

    const intentAtomic = BigInt(fixtures.intent.amount.amount);
    const intentAsset = fixtures.intent.amount.asset;
    const intentDecimals = fixtures.intent.amount.decimals;

    /** A different asset on the same chain, built through the CAIP helpers. */
    const otherAsset: AssetId = (() => {
      const parsed = parseAssetId(intentAsset);
      return toAssetId(
        parsed.chainId,
        parsed.assetNamespace,
        mutateString(parsed.assetReference, accounts),
      );
    })();

    // 11
    it('throws when the observed asset is not the intent asset', async () => {
      expect(
        await codeOf(() =>
          adapter.extractSettledAmount(
            fixtures.intent,
            receiptOf({
              amount: intentAtomic.toString(),
              asset: otherAsset,
              decimals: intentDecimals,
            }),
          ),
        ),
      ).toBe(ChainErrorCode.CHAIN_SETTLED_ASSET_MISMATCH);
    });

    // 12
    it('throws when the observed amount is below the intent amount', async () => {
      expect(
        await codeOf(() =>
          adapter.extractSettledAmount(
            fixtures.intent,
            receiptOf({
              amount: (intentAtomic - 1n).toString(),
              asset: intentAsset,
              decimals: intentDecimals,
            }),
          ),
        ),
      ).toBe(ChainErrorCode.CHAIN_SETTLED_AMOUNT_BELOW_INTENT);
    });

    // 11, 12 — the dimension neither of them encodes.
    //
    // Every other receipt in this block carries the intent's own `decimals`, so
    // an adapter that compares atomic DIGIT STRINGS with no notion of scale
    // passes all four cases — and then credits 10,000 USDC for an observed
    // `'10000'` at scale 0, which is 0.01 USDC paid. The reference adapter is
    // saved by `MoneyUtil.compare`, which is why the accepted code is a
    // `MONEY_*` one: the port has no `CHAIN_*` vocabulary for this, and an
    // adapter that grows one should be widening this list, not silently
    // passing.
    it('throws when the observed scale is not the intent scale', async () => {
      const code = await codeOf(() =>
        adapter.extractSettledAmount(
          fixtures.intent,
          receiptOf({
            amount: intentAtomic.toString(),
            asset: intentAsset,
            decimals: intentDecimals + 1,
          }),
        ),
      );
      expect([
        MoneyErrorCode.MONEY_DECIMALS_MISMATCH,
        ChainErrorCode.CHAIN_ASSET_DECIMALS_MISMATCH,
        ChainErrorCode.CHAIN_SETTLED_ASSET_MISMATCH,
      ]).toContain(code);
    });

    // 13
    it('returns the OBSERVED amount, not the intent amount, when the payer overpays', () => {
      const overpaid = (intentAtomic + 7n).toString();

      const settled = adapter.extractSettledAmount(
        fixtures.intent,
        receiptOf({ amount: overpaid, asset: intentAsset, decimals: intentDecimals }),
      );

      // Both halves matter. Only the first is the property; the second is what
      // fails if the adapter credits `intent.amount` and the two happen to be
      // compared loosely.
      expect(settled.amount).toBe(overpaid);
      expect(settled.amount).not.toBe(fixtures.intent.amount.amount);
      expect(settled.asset).toBe(intentAsset);
    });

    // 13 — the exact-payment case, so "returns the observed amount" cannot be
    // satisfied by an adapter that always adds something.
    it('returns the exact amount when the payer pays exactly', () => {
      const settled = adapter.extractSettledAmount(
        fixtures.intent,
        receiptOf({
          amount: intentAtomic.toString(),
          asset: intentAsset,
          decimals: intentDecimals,
        }),
      );
      expect(settled.amount).toBe(intentAtomic.toString());
    });

    // ── Observing what landed ────────────────────────────────────────────

    // 14
    it('returns null — not a throw — for a transaction reference the chain cannot find', async () => {
      await expect(
        adapter.observeTransfer(fixtures.intent, fixtures.unknownTransaction),
      ).resolves.toBeNull();
    });

    // 14 — the control. `observeTransfer = async () => null` satisfies the
    // assertion above completely, and is also the shape of the worst bug this
    // method can have: a deposit that never credits.
    it('reports what a transaction it CAN find actually moved', async () => {
      await expect(
        adapter.observeTransfer(fixtures.intent, fixtures.settledTransaction),
      ).resolves.toEqual(fixtures.settledTransfer);
    });

    // 14 — the control's own control. On its own, the case above is satisfied
    // by `async () => SOME_CONSTANT` where the constant is the fixture field —
    // the "mock returns a hardcoded value, so the assertion checks a constant
    // the mock itself set" shape. This is what makes the reader read: the same
    // transaction, observed for someone else's account, moved them nothing.
    //
    // Both `payTo` AND `payer` move, to an account that is neither. Which of
    // the two names the credited account is a per-chain fact — the escrow PDA
    // on Solana, the buyer on EVM, where `payTo` is the pooled contract — and
    // mutating only `payTo` passed an EVM adapter that reads `payer` without
    // proving anything about it.
    it('reports nothing for a payee the transaction did not pay', async () => {
      const otherPayee = otherAccountThan(fixtures.intent.payTo, accounts, [fixtures.intent.payer]);
      await expect(
        adapter.observeTransfer(
          { ...fixtures.intent, payTo: otherPayee, payer: otherPayee },
          fixtures.settledTransaction,
        ),
      ).resolves.toBeNull();
    });

    // ── Signed structures ────────────────────────────────────────────────

    // 15, 16, 17, 18
    describeSignedStructure<Voucher>(
      {
        label: 'voucher',
        value: fixtures.voucher,
        signature: fixtures.voucherSignature,
        signer: fixtures.voucherSigner,
        alternateSignature: fixtures.voucherSignatureBySecondSigner,
        alternateSigner: fixtures.secondSigner,
        build: (value) => adapter.buildVoucherMessage(value),
        verify: (value, signature, signer) =>
          adapter.verifyVoucherSignature(value, signature, signer),
      },
      accounts,
    );

    // 19
    describeSignedStructure<PayoutProofChallenge>(
      {
        label: 'payout proof',
        value: fixtures.payoutChallenge,
        signature: fixtures.payoutSignature,
        signer: fixtures.payoutSigner,
        alternateSignature: fixtures.payoutSignatureBySecondSigner,
        alternateSigner: fixtures.secondSigner,
        build: (value) => adapter.buildPayoutProofMessage(value),
        verify: (value, signature, signer) =>
          adapter.verifyPayoutProofSignature(value, signature, signer),
      },
      accounts,
    );

    // 19
    describeSignedStructure<StakeAuthorityChallenge>(
      {
        label: 'stake authority',
        value: fixtures.stakeChallenge,
        signature: fixtures.stakeSignature,
        signer: fixtures.stakeSigner,
        alternateSignature: fixtures.stakeSignatureBySecondSigner,
        alternateSigner: fixtures.secondSigner,
        build: (value) => adapter.buildStakeAuthorityMessage(value),
        verify: (value, signature, signer) =>
          adapter.verifyStakeAuthoritySignature(value, signature, signer),
      },
      accounts,
    );

    // 20
    it('produces pairwise-distinct bytes for the three message kinds', () => {
      // The port's core promise, and the only mechanical check of it: a
      // signature collected for the harmless claim (prove you own a payout
      // address) must not satisfy the dangerous one (spend this buyer's
      // escrow). The inputs are made deliberately SIMILAR — same account, same
      // nonce-shaped string, same expiry, same organization — because distinct
      // bytes for obviously different inputs proves nothing.
      const { account, organizationId, nonce, expiresAt } = fixtures.payoutChallenge;

      const messages = [
        adapter.buildVoucherMessage(fixtures.voucher),
        adapter.buildPayoutProofMessage({ account, organizationId, nonce, expiresAt }),
        adapter.buildStakeAuthorityMessage({ account, organizationId, nonce, expiresAt }),
      ].map(hex);

      expect(new Set(messages).size).toBe(3);
    });

    // 20 — the same property stated as the attack, so it survives an encoder
    // that makes the bytes differ by something a verifier ignores.
    it('refuses a payout-proof signature as a stake-authority proof, and the reverse', () => {
      const shared = {
        organizationId: fixtures.payoutChallenge.organizationId,
        nonce: fixtures.payoutChallenge.nonce,
        expiresAt: fixtures.payoutChallenge.expiresAt,
      };

      expect(
        adapter.verifyStakeAuthoritySignature(
          { account: fixtures.payoutChallenge.account, ...shared },
          fixtures.payoutSignature,
          fixtures.payoutSigner,
        ),
      ).toBe(false);
      expect(
        adapter.verifyPayoutProofSignature(
          { account: fixtures.stakeChallenge.account, ...shared },
          fixtures.stakeSignature,
          fixtures.stakeSigner,
        ),
      ).toBe(false);
    });

    // ── Vault ────────────────────────────────────────────────────────────

    // 21
    it('returns a vault AccountId on the same chain as its owner', async () => {
      const owner = fixtures.intent.payTo;
      const vault = await adapter.getVaultAccount(owner, fixtures.asset);

      expect(isAccountId(vault)).toBe(true);
      expect(chainIdOf(vault)).toBe(chainIdOf(owner));
      expect(adapter.parseAccountId(vault).chainId).toBe(chainIdOf(owner));
    });

    // 21 — the control. `getVaultAccount = async () => owner` and
    // `async () => SOME_CONSTANT` both satisfy the assertion above; paying
    // either of those is a lost transfer.
    it('derives a distinct vault account for each distinct owner, deterministically', async () => {
      const owner = fixtures.intent.payTo;
      const otherOwner = otherAccountThan(owner, accounts);

      const [first, second, other] = await Promise.all([
        adapter.getVaultAccount(owner, fixtures.asset),
        adapter.getVaultAccount(owner, fixtures.asset),
        adapter.getVaultAccount(otherOwner, fixtures.asset),
      ]);

      expect(second).toBe(first);
      expect(other).not.toBe(first);
    });

    // Beyond the numbered list — `getVaultBalance` is a port method the numbered list never
    // reaches, so the only call the suite made was one the adapter refuses. An
    // implementation that threw `new Error('unimplemented')` from it was
    // conformant.
    it('reads a vault balance as Money in the asset it was asked about', async () => {
      const balance = await adapter.getVaultBalance(fixtures.intent.payTo, fixtures.asset);

      expect(balance.asset).toBe(fixtures.asset);
      expect(balance.decimals).toBe(getAssetMetadata(fixtures.asset).decimals);
      expect(balance.amount).toMatch(/^\d+$/);
    });

    // ── Foreign chains ───────────────────────────────────────────────────

    // 22 — twice over, and the second probe is the one that matters.
    //
    // The list says "outside `supportedChains`". Probed only with a chain from
    // ANOTHER NAMESPACE, an adapter whose guard is
    // `namespaceOf(chainId) === this.namespace` passes every case — measured on
    // the reference adapter, that mutation left all 92 contract cases green and
    // was caught only by Solana's own spec. That guard is a devnet deployment
    // that quietly serves mainnet.
    const UNSERVED_CHAINS: readonly (readonly [string, ChainId])[] = [
      ['a chain id in another namespace', fixtures.otherNamespaceChainId],
      ['an unserved chain id in its own namespace', fixtures.unservedSameNamespaceChainId],
    ];

    it.each(
      CHAIN_SCOPED_METHODS.flatMap((method) =>
        UNSERVED_CHAINS.map(([label, chainId]) => [method, label, chainId] as const),
      ),
    )('%s refuses %s', async (method, _label, unservedChainId) => {
      const unservedAccount = `${unservedChainId}:${fixtures.validAddress}` as AccountId;
      const calls: Record<ChainScopedMethod, () => unknown> = {
        isValidAddress: () => adapter.isValidAddress(unservedChainId, fixtures.validAddress),
        toAccountId: () => adapter.toAccountId(unservedChainId, fixtures.validAddress),
        parseAccountId: () => adapter.parseAccountId(unservedAccount),
        buildPaymentRequirements: () =>
          adapter.buildPaymentRequirements({
            ...fixtures.requirementsInput,
            chainId: unservedChainId,
          }),
        assertPayloadBoundToIntent: () =>
          adapter.assertPayloadBoundToIntent(
            { ...fixtures.boundPayload, network: unservedChainId },
            { ...fixtures.intent, chainId: unservedChainId },
          ),
        // Intent AND receipt on the unserved chain. Leaving the receipt on the
        // intent's own chain would make the pair wrong in two ways, and the
        // case would then pass for an adapter that has only the
        // receipt-network comparison and no `supportedChains` guard at all.
        extractSettledAmount: () =>
          adapter.extractSettledAmount(
            { ...fixtures.intent, chainId: unservedChainId },
            {
              transaction: fixtures.settledTransaction,
              network: unservedChainId,
              payer: fixtures.voucherSigner,
              observed: {
                amount: fixtures.intent.amount.amount,
                asset: fixtures.intent.amount.asset,
                decimals: fixtures.intent.amount.decimals,
              },
            },
          ),
        observeTransfer: () =>
          adapter.observeTransfer(
            { ...fixtures.intent, chainId: unservedChainId },
            fixtures.settledTransaction,
          ),
        getVaultAccount: () => adapter.getVaultAccount(unservedAccount, fixtures.asset),
        getVaultBalance: () => adapter.getVaultBalance(unservedAccount, fixtures.asset),
        buildVoucherMessage: () =>
          adapter.buildVoucherMessage({ ...fixtures.voucher, payer: unservedAccount }),
        verifyVoucherSignature: () =>
          adapter.verifyVoucherSignature(
            fixtures.voucher,
            fixtures.voucherSignature,
            unservedAccount,
          ),
        verifyPayoutProofSignature: () =>
          adapter.verifyPayoutProofSignature(
            fixtures.payoutChallenge,
            fixtures.payoutSignature,
            unservedAccount,
          ),
        verifyStakeAuthoritySignature: () =>
          adapter.verifyStakeAuthoritySignature(
            fixtures.stakeChallenge,
            fixtures.stakeSignature,
            unservedAccount,
          ),
      };

      expect(REFUSES_A_FOREIGN_CHAIN).toContain(await codeOf(calls[method]));
    });
  });
}
