import { secp256k1 } from '@noble/curves/secp256k1';
import { getAddress, keccak256 } from 'viem';

import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { PayoutProofChallenge } from '@modules/chains/ports/payout-proof.types';
import { StakeAuthorityChallenge } from '@modules/chains/ports/stake-authority.types';
import { PaymentIntent, PaymentPayload, Voucher } from '@modules/chains/ports/x402.types';
import { MoneyUtil } from '@shared/utils/money.util';

import { depositTransaction, deployment, generateSigner, onChain } from './evm-fixtures';

/**
 * The `eip155` **behaviour** spec — the second half of the requirement whose
 * first half is `eip155-adapter.contract.spec.ts`.
 *
 * ## Why this file is a deliverable and not a nicety
 *
 * Measured on this branch, twice. A deliberately degenerate adapter — keyless
 * `sha256(tag | JSON | signer)` for signing, `payload.bound === true` for the
 * binding, an identity vault, a non-checksummed address regex, a constant
 * `observeTransfer`, a zero balance — passed the shared conformance suite
 * **115/115 cases and all 22 assertions on its first run**. The same experiment
 * on the Solana adapter passed 22/22 and 92/92 first try. Three reasons, none
 * of them closable from inside `chain-adapter.contract.ts`:
 *
 *  - **No assertion there requires cryptography.** Every signing case is a
 *    consistency check between `build`, `verify` and a signature the fixture
 *    supplied, so a keyless, publicly forgeable checksum satisfies all of them.
 *  - **A signed binding is indistinguishable from a client-supplied boolean**,
 *    because the payload is opaque to the port by design.
 *  - **`registry-coverage.spec.ts` demanded a contract spec per namespace and
 *    no behaviour spec at all**, so nothing kept one alive once written. That
 *    is what `behaviour-spec-coverage.spec.ts`, beside this file, now fixes.
 *
 * ## What lives here, and what lives beside it
 *
 * The `eip155` behaviour spec is four files, and this one is the roof. Its
 * siblings carry the bulk, and each is named where its subject is:
 *
 *  - `evm-signing.spec.ts` — the cryptography: an attacker's genuine signature,
 *    viem `signTypedData` interop, malleation, the deterministic 162-signature
 *    structured `(r, s)` sweep, the chain and `payTo` bindings in the digest.
 *  - `evm-chain.adapter.identity.spec.ts` — EIP-55 at the minting door, the
 *    vault, and the served/unserved split.
 *  - `evm-chain.adapter.x402.spec.ts` — requirements, the payload binding read
 *    out of serialized transaction bytes, the settled-amount guards, the
 *    `Deposited` decode and the twelve-field `Escrow` struct.
 *
 * This file holds what none of them reach: the inputs where a verifier must
 * answer rather than throw, the **one** malformed `v` that recovery does not
 * reject on its own, the binding stated as the degenerate it must refuse (and
 * the residual it honestly does not close), the vault as a real derivation, and
 * the two proof messages crossed with real signatures.
 */

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const OTHER_CHAIN = CHAIN_IDS.BASE_SEPOLIA;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const OTHER_ASSET = `${OTHER_CHAIN}/erc20:${deployment(OTHER_CHAIN).asset}` as AssetId;

const TESTNET_DEPLOYMENT = deployment(TESTNET);
const ESCROW_ACCOUNT = `${TESTNET}:${TESTNET_DEPLOYMENT.escrow}` as AccountId;

/** EIP-55 checksummed, and the same twenty bytes with one case flipped. */
const BUYER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const BUYER_ACCOUNT = `${TESTNET}:${BUYER}` as AccountId;
/** `B` → `b` at index 3. Same bytes, a checksum that no longer verifies. */
const BAD_CHECKSUM = '0x5b38Da6a701c568545dCfcB03FcB875f56beddC4';

const adapter = new EvmChainAdapter(
  new Map(),
  new Map([
    [TESTNET, TESTNET_DEPLOYMENT],
    [OTHER_CHAIN, deployment(OTHER_CHAIN)],
  ]),
  [TESTNET, OTHER_CHAIN],
);

const payer = generateSigner(TESTNET);
const provider = generateSigner(TESTNET);

const voucher: Voucher = {
  payer: payer.account,
  payTo: ESCROW_ACCOUNT,
  provider: provider.account,
  amount: MoneyUtil.of('10000', USDG, 6),
  resource: 'https://api.platform.io/tools/search_web',
  requestHash: `sha256:${'a3f1c0de'.repeat(8)}`,
  seq: '42',
  issuedAt: 1_785_999_800,
  expiresAt: 1_786_000_000,
};

const digest = adapter.buildVoucherMessage(voucher);
const genuine = payer.sign(digest);

const payoutChallenge: PayoutProofChallenge = {
  account: payer.account,
  organizationId: 'org-11111111-1111-4111-8111-111111111111',
  nonce: 'd0dfc3aa6a49b2f2d69bb4f1a9d5f7c1d0dfc3aa6a49b2f2d69bb4f1a9d5f7c1',
  expiresAt: 1_786_000_000,
};

/**
 * The same four values as the other challenge type.
 *
 * Identical on purpose: distinct behaviour for obviously different inputs
 * proves nothing about whether the two encoders are separated. The two
 * interfaces carry incompatible phantom brands, so the test has to build both
 * rather than cast one into the other.
 */
const stakeChallenge: StakeAuthorityChallenge = {
  account: payoutChallenge.account,
  organizationId: payoutChallenge.organizationId,
  nonce: payoutChallenge.nonce,
  expiresAt: payoutChallenge.expiresAt,
};

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { errorCode?: string }).errorCode;
  }
  return undefined;
};

// ── Residue 1: cryptography, at the edges the sweep does not reach ─────────

describe('the EVM verifiers answer, and never throw, for input that is not a signature', () => {
  /**
   * Every shape a caller can hand a `verify*` method that is not 65 bytes of
   * hex.
   *
   * The port's three `verify*` methods return a boolean, and a `TypeError` out
   * of a curve library is not a boolean — it is the 500-with-a-stack-trace this
   * whole port exists to convert into an answer. `chain-adapter.contract.ts`
   * checks this for `verifyVoucherSignature` only, and only with values its own
   * chain-agnostic `mutateString` can produce; none of these five survive it.
   */
  const NOT_A_SIGNATURE: readonly (readonly [string, string])[] = [
    ['the empty string', '0x'],
    ['64 bytes — r and s with no v', `0x${'11'.repeat(64)}`],
    ['66 bytes — one byte too many', `0x${'11'.repeat(66)}`],
    ['pure garbage', 'not-hex'],
    ['65 bytes of the right length but odd nibbles', `0x${'1'.repeat(129)}`],
  ];

  it.each(NOT_A_SIGNATURE)('verifyVoucherSignature: %s', (_label, bad) => {
    expect(() => adapter.verifyVoucherSignature(voucher, bad, payer.account)).not.toThrow();
    expect(adapter.verifyVoucherSignature(voucher, bad, payer.account)).toBe(false);
  });

  it.each(NOT_A_SIGNATURE)('verifyPayoutProofSignature: %s', (_label, bad) => {
    expect(() =>
      adapter.verifyPayoutProofSignature(payoutChallenge, bad, payer.account),
    ).not.toThrow();
    expect(adapter.verifyPayoutProofSignature(payoutChallenge, bad, payer.account)).toBe(false);
  });

  it.each(NOT_A_SIGNATURE)('verifyStakeAuthoritySignature: %s', (_label, bad) => {
    expect(() =>
      adapter.verifyStakeAuthoritySignature(stakeChallenge, bad, payer.account),
    ).not.toThrow();
    expect(adapter.verifyStakeAuthoritySignature(stakeChallenge, bad, payer.account)).toBe(false);
  });

  it('and the controls: each genuine signature still verifies under its own pair', () => {
    // Without these, `verify* = () => false` passes every case above.
    expect(adapter.verifyVoucherSignature(voucher, genuine, payer.account)).toBe(true);
    expect(
      adapter.verifyPayoutProofSignature(
        payoutChallenge,
        payer.sign(adapter.buildPayoutProofMessage(payoutChallenge)),
        payer.account,
      ),
    ).toBe(true);
    expect(
      adapter.verifyStakeAuthoritySignature(
        stakeChallenge,
        payer.sign(adapter.buildStakeAuthorityMessage(stakeChallenge)),
        payer.account,
      ),
    ).toBe(true);
  });
});

describe('the v ∈ {27, 28} check, at the one input that makes it reachable', () => {
  /**
   * Deleting `v !== 27 && v !== 28` from `secp256k1-recover.ts` leaves **all
   * 332 EVM cases green** — measured when the check was written and carried
   * forward here rather than quietly dropped. The reason is that `@noble` throws for every other
   * byte a test would naturally reach for: `00` and `01` become a negative
   * recovery bit, and `1d` (29) and `ff` become recovery id 2 or 3, which means
   * "the x coordinate is `r + n`" and overflows the field for any `r` a real
   * signature produces.
   *
   * `r = 2` is the input where it does **not** overflow. `2 + n` is below the
   * field prime and lands on the curve, so recovery succeeds and names a real
   * account — and the ONLY thing refusing the signature is the `v` byte. That
   * is [[fuzzing-never-finds-structured-small-values]] in one case: uniform
   * `bytes32` draws never produce `r = 2`.
   */
  const STRUCTURED_R = 2n;
  /** `v = 29`, i.e. recovery id 2, the branch that reads `x = r + n`. */
  const V_TWENTY_NINE = '1d';

  const s = BigInt(`0x${genuine.slice(66, 130)}`);
  const signature = `0x${STRUCTURED_R.toString(16).padStart(64, '0')}${s
    .toString(16)
    .padStart(64, '0')}${V_TWENTY_NINE}`;

  /**
   * The account that signature recovers to, computed with `@noble` directly.
   *
   * This is not the adapter's answer restated: it establishes that the case is
   * **not vacuous** — that recovery genuinely succeeds here — so the adapter's
   * `false` is attributable to the `v` check and to nothing else.
   */
  const recovered = getAddress(
    `0x${keccak256(
      new secp256k1.Signature(STRUCTURED_R, s)
        .addRecoveryBit(2)
        .recoverPublicKey(Buffer.from(digest).toString('hex'))
        .toRawBytes(false)
        .subarray(1),
    ).slice(-40)}`,
  );

  it('the fixture is not vacuous: an INDEPENDENT library recovers a real account from it', () => {
    expect(recovered).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(recovered).not.toBe('0x0000000000000000000000000000000000000000');
    // And the `s` is a genuine low-`s`, so the low-`s` guard is not what is
    // doing the refusing below.
    expect(s).toBeLessThanOrEqual(secp256k1.CURVE.n / 2n);
  });

  it('REFUSES it anyway, because 29 is not a recovery id this scheme emits', () => {
    expect(
      adapter.verifyVoucherSignature(voucher, signature, `${TESTNET}:${recovered}` as AccountId),
    ).toBe(false);
  });

  it('the control: the same r and s under a v this scheme DOES emit is answered, not refused blindly', () => {
    // `v = 27` over the same `(r, s)` recovers to some other account. The point
    // is that the pair is not intrinsically unrecoverable — so the refusal
    // above is about the byte, not about the numbers beside it.
    const withV27 = `${signature.slice(0, -2)}1b`;
    const recoveredAt27 = getAddress(
      `0x${keccak256(
        new secp256k1.Signature(STRUCTURED_R, s)
          .addRecoveryBit(0)
          .recoverPublicKey(Buffer.from(digest).toString('hex'))
          .toRawBytes(false)
          .subarray(1),
      ).slice(-40)}`,
    );
    expect(
      adapter.verifyVoucherSignature(voucher, withV27, `${TESTNET}:${recoveredAt27}` as AccountId),
    ).toBe(true);
  });
});

// ── Residue 2: the binding is read out of signed bytes ─────────────────────

describe('assertPayloadBoundToIntent reads signed bytes, not a client claim', () => {
  const intent: PaymentIntent = {
    id: 'pi_01J8XZQ4M0000000000000',
    resource: 'https://api.platform.io/tools/search_web',
    amount: MoneyUtil.of('10000', USDG, 6),
    // What `DepositService` passes: the pooled contract as `payTo`, the buyer
    // as `payer`. Setting both to the buyer is how the live refusal hid.
    payTo: ESCROW_ACCOUNT,
    payer: BUYER_ACCOUNT,
    chainId: TESTNET,
    expiresAt: new Date('2026-09-09T00:01:00.000Z'),
  };

  const payloadOf = (payload: Record<string, unknown>): PaymentPayload => ({
    x402Version: 2,
    scheme: 'exact',
    network: TESTNET,
    payload,
  });

  it('accepts a transaction whose own bytes credit this buyer for this price', () => {
    // The control. Every refusal below is worthless without it: an
    // `assertPayloadBoundToIntent` that throws unconditionally passes them all.
    expect(
      adapter.assertPayloadBoundToIntent(
        payloadOf({ transaction: depositTransaction({ buyer: BUYER, amount: 10_000n }) }),
        intent,
      ),
    ).toBeUndefined();
  });

  it('REFUSES a payload that merely CLAIMS to be bound', () => {
    // `{ bound: true }` is a legal opaque payload and satisfies assertion 9 as
    // `chain-adapter.contract.ts` writes it — the shared suite is forbidden
    // from knowing any chain's payload format, so it cannot tell this apart
    // from a memo read out of a signed transaction. This is where that gap
    // closes, named as the exact degenerate adapter it has to refuse.
    expect(
      codeOf(() => adapter.assertPayloadBoundToIntent(payloadOf({ bound: true }), intent)),
    ).toBe(ChainErrorCode.CHAIN_PAYLOAD_MALFORMED);
  });

  it.each([
    ['a boolean beside a valid transaction cannot rescue a wrong one', { bound: true }],
    ['nor can an intent id asserted alongside it', { intentId: 'pi_01J8XZQ4M0000000000000' }],
  ])('%s', (_label, extra) => {
    // The sharper form of the case above: the claim travels WITH a transaction
    // that credits somebody else. An implementation that reads either field
    // accepts this; one that reads the transaction does not.
    const other = generateSigner(TESTNET);
    expect(
      codeOf(() =>
        adapter.assertPayloadBoundToIntent(
          payloadOf({
            ...extra,
            transaction: depositTransaction({ buyer: other.address, amount: 10_000n }),
          }),
          intent,
        ),
      ),
    ).toBe(ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT);
  });

  /**
   * **The residual this method does not close, pinned rather than described.**
   *
   * `depositFor(address,uint64)` has no free field, so there is nowhere for an
   * intent id to go: two intents for the same buyer and the same amount are
   * both satisfied by one transaction. On SVM the memo closes that. On EVM the
   * closing move is the x402 `authorization.nonce` of an EIP-3009 transfer, and
   * USDG implements neither EIP-3009 nor EIP-2612 (measured,
   * `assay-evm/docs/chain-facts.md`). Rail A is off on `eip155:46630`
   * (`chain-metadata.ts` lists `rails: ['B']`), so this method has no
   * production caller today.
   *
   * The case is written as an assertion rather than a comment so that whoever
   * closes it has to come here and change a test, instead of closing it
   * silently and leaving the record behind claiming a gap that is gone.
   */
  it('does NOT distinguish two intents that differ only in their id — the known residual', () => {
    const transaction = depositTransaction({ buyer: BUYER, amount: 10_000n });
    const second: PaymentIntent = { ...intent, id: 'pi_01J8XZQ4M0000000000001' };

    expect(second.id).not.toBe(intent.id);
    expect(adapter.assertPayloadBoundToIntent(payloadOf({ transaction }), intent)).toBeUndefined();
    expect(adapter.assertPayloadBoundToIntent(payloadOf({ transaction }), second)).toBeUndefined();
  });
});

// ── Residue 3: a real vault derivation and real address validation ─────────

describe('the vault is derived, not constant, and not the pooled escrow', () => {
  it('is a distinct account per owner, and stable for one owner', async () => {
    // `getVaultAccount = async () => SOME_CONSTANT` satisfies assertion 21's
    // shape check; paying a constant is a lost transfer for every buyer but
    // the first.
    const other = generateSigner(TESTNET);

    const [first, again, foreign] = await Promise.all([
      adapter.getVaultAccount(payer.account, USDG),
      adapter.getVaultAccount(payer.account, USDG),
      adapter.getVaultAccount(other.account, USDG),
    ]);

    expect(again).toBe(first);
    expect(foreign).not.toBe(first);
  });

  it('is never the pooled escrow contract — the answer that looks careful and loses money', async () => {
    // Measured by `test_donationsDoNotBecomeAnybodysBalance` in assay-evm: one contract holds
    // every buyer, so a plain transfer to it has no sender attribution the
    // contract can see and the money is unrecoverable. Returning the escrow
    // here would put it in `PaymentRequirements.payTo`, which is exactly where
    // a wallet renders a send-to target.
    await expect(adapter.getVaultAccount(payer.account, USDG)).resolves.not.toBe(ESCROW_ACCOUNT);
    await expect(adapter.getVaultAccount(payer.account, USDG)).resolves.toBe(payer.account);
  });

  it('is per chain: one key controls one address on every EVM chain, and they are two vaults', async () => {
    // The same twenty bytes, two chains. If the vault dropped the chain, a
    // testnet balance and a Base balance would be one row.
    const here = await adapter.getVaultAccount(payer.account, USDG);
    const there = await adapter.getVaultAccount(onChain(payer, OTHER_CHAIN).account, OTHER_ASSET);

    expect(there).not.toBe(here);
    expect(here).toBe(`${TESTNET}:${payer.address}`);
    expect(there).toBe(`${OTHER_CHAIN}:${payer.address}`);
  });
});

describe('a mixed-case address with a broken checksum is refused at every door', () => {
  /**
   * Non-vacuity, first. `BAD_CHECKSUM` must be the SAME twenty bytes as
   * `BUYER` and differ only in case — otherwise the refusals below are about a
   * different address rather than about a checksum, and would survive deleting
   * the checksum check entirely.
   */
  it('the fixture violates exactly one thing: the checksum, and nothing else', () => {
    expect(BAD_CHECKSUM).not.toBe(BUYER);
    expect(BAD_CHECKSUM.toLowerCase()).toBe(BUYER.toLowerCase());
    expect(adapter.isValidAddress(TESTNET, BUYER)).toBe(true);
    expect(adapter.isValidAddress(TESTNET, BUYER.toLowerCase())).toBe(true);
  });

  it.each([
    ['isValidAddress', () => adapter.isValidAddress(TESTNET, BAD_CHECKSUM)],
    ['toAccountId', () => adapter.toAccountId(TESTNET, BAD_CHECKSUM)],
    ['parseAccountId', () => adapter.parseAccountId(`${TESTNET}:${BAD_CHECKSUM}` as AccountId)],
    [
      'getVaultAccount',
      () => adapter.getVaultAccount(`${TESTNET}:${BAD_CHECKSUM}` as AccountId, USDG),
    ],
  ])('%s refuses it', async (name, call) => {
    // `isValidAddress` answers rather than throws — it is the only door of the
    // four whose contract is a boolean — so the two shapes are distinguished
    // here rather than papered over with a single `toThrow`.
    if (name === 'isValidAddress') {
      expect(call()).toBe(false);
      return;
    }
    await expect(async () => await call()).rejects.toMatchObject({
      errorCode: ChainErrorCode.CHAIN_INVALID_ADDRESS,
    });
  });

  it('and a correctly checksummed address passes all four', async () => {
    // The control for the block above, which an unconditional throw satisfies.
    expect(adapter.isValidAddress(TESTNET, BUYER)).toBe(true);
    expect(adapter.toAccountId(TESTNET, BUYER)).toBe(BUYER_ACCOUNT);
    expect(adapter.parseAccountId(BUYER_ACCOUNT).address).toBe(BUYER);
    await expect(adapter.getVaultAccount(BUYER_ACCOUNT, USDG)).resolves.toBe(BUYER_ACCOUNT);
  });
});

// ── The two proof messages, crossed with REAL signatures ──────────────────

describe('a payout proof and a stake-authority proof cannot stand in for each other', () => {
  /**
   * Assertion 20 of the contract suite compares the two encoders' **bytes**.
   * This is the consequence: same account, same organizationId, same nonce,
   * same expiry — one wallet apart from nothing at all. If the two shared an
   * encoder, a signature collected for the harmless claim ("pay me here") would
   * attach somebody else's collateral.
   */
  const payoutSignature = payer.sign(adapter.buildPayoutProofMessage(payoutChallenge));
  const stakeSignature = payer.sign(adapter.buildStakeAuthorityMessage(stakeChallenge));

  it('the two signatures are different strings over identical field values', () => {
    // Non-vacuity: if the encoders agreed, both crossings below would still
    // pass — as `true`s — and the block would prove the opposite of its name.
    expect(payoutSignature).not.toBe(stakeSignature);
  });

  it('a payout-proof signature does not satisfy the stake-authority proof', () => {
    expect(
      adapter.verifyPayoutProofSignature(payoutChallenge, payoutSignature, payer.account),
    ).toBe(true);
    expect(
      adapter.verifyStakeAuthoritySignature(stakeChallenge, payoutSignature, payer.account),
    ).toBe(false);
  });

  it('and the stake-authority signature does not satisfy the payout proof', () => {
    expect(
      adapter.verifyStakeAuthoritySignature(stakeChallenge, stakeSignature, payer.account),
    ).toBe(true);
    expect(adapter.verifyPayoutProofSignature(payoutChallenge, stakeSignature, payer.account)).toBe(
      false,
    );
  });

  it('the separation survives the two contracts being swapped out for one another', () => {
    // `verifyingContract` is one of the two things separating the domains — the
    // other is the EIP-712 primary type. If only the contract separated them,
    // a deployment that ever pointed both at one address would silently merge
    // the two proofs. Same challenge, same key, and the ESCROW domain: the
    // stake proof must still not verify as a payout proof.
    const escrowOnly = new EvmChainAdapter(
      new Map(),
      new Map([[TESTNET, { ...TESTNET_DEPLOYMENT, stake: TESTNET_DEPLOYMENT.escrow }]]),
      [TESTNET],
    );
    const underOneContract = payer.sign(escrowOnly.buildStakeAuthorityMessage(stakeChallenge));

    expect(
      escrowOnly.verifyStakeAuthoritySignature(stakeChallenge, underOneContract, payer.account),
    ).toBe(true);
    expect(
      escrowOnly.verifyPayoutProofSignature(payoutChallenge, underOneContract, payer.account),
    ).toBe(false);
  });
});
