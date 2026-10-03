import { secp256k1 } from '@noble/curves/secp256k1';
import { getAddress, keccak256, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { EVM_DOMAIN_NAME, EVM_DOMAIN_VERSION } from '@modules/chains/evm/eip712/domain';
import { evmDomain } from '@modules/chains/evm/eip712/domain';
import { VOUCHER_TYPES, hashVoucher } from '@modules/chains/evm/eip712/voucher';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { PayoutProofChallenge } from '@modules/chains/ports/payout-proof.types';
import { StakeAuthorityChallenge } from '@modules/chains/ports/stake-authority.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import { MoneyUtil } from '@shared/utils/money.util';

import { deployment, generateSigner } from './evm-fixtures';

/**
 * The cryptography the shared conformance suite cannot demand.
 *
 * `chain-adapter.contract.ts` says so in its own header: every signing
 * assertion there is a consistency check between `build`, `verify` and a
 * signature the fixture supplied, so a keyless, publicly forgeable
 * `sha256(tag | JSON(value) | signer)` passes all 115 of its cases. Nothing
 * available to a black-box contract kills that family. This file is where it
 * dies, and each block below names the degenerate it removes.
 */

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const OTHER_CHAIN = CHAIN_IDS.BASE_SEPOLIA;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const TESTNET_DEPLOYMENT = deployment(TESTNET);
const ESCROW_ACCOUNT = `${TESTNET}:${TESTNET_DEPLOYMENT.escrow}` as AccountId;

const adapter = new EvmChainAdapter(
  new Map(),
  new Map([
    [TESTNET, TESTNET_DEPLOYMENT],
    [OTHER_CHAIN, deployment(OTHER_CHAIN)],
  ]),
  [TESTNET, OTHER_CHAIN],
);

const payer = generateSigner(TESTNET);
const attacker = generateSigner(TESTNET);

const voucher: Voucher = {
  payer: payer.account,
  payTo: ESCROW_ACCOUNT,
  provider: `${TESTNET}:0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2` as AccountId,
  amount: MoneyUtil.of('10000', USDG, 6),
  resource: 'https://api.platform.io/tools/search_web',
  requestHash: `sha256:${'a3f1c0de'.repeat(8)}`,
  seq: '42',
  issuedAt: 1_785_999_800,
  expiresAt: 1_786_000_000,
};

const digest = adapter.buildVoucherMessage(voucher);
const genuine = payer.sign(digest);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('EvmChainAdapter voucher signatures are secp256k1, not a checksum', () => {
  it('accepts the payer’s own signature (the control every negative below needs)', () => {
    expect(adapter.verifyVoucherSignature(voucher, genuine, payer.account)).toBe(true);
  });

  it('refuses an ATTACKER’s genuine signature over the very same voucher', () => {
    // The one property no black-box conformance suite can ask for: the scheme
    // has a secret in it. A forgeable checksum over public inputs passes every
    // assertion in `chain-adapter.contract.ts` and fails here.
    const forged = attacker.sign(digest);
    expect(forged).not.toBe(genuine);
    expect(adapter.verifyVoucherSignature(voucher, forged, payer.account)).toBe(false);

    // It DOES verify under the attacker's own account, and that is the port's
    // contract rather than a hole: the method answers "did THIS account sign
    // these bytes?", and contract assertion 19 requires a second, unrelated key
    // holder's genuine signature over the same voucher to verify. Refusing here
    // would be answering a different question — and "the signer is the payer"
    // is checked where it belongs, by `VoucherService.assertAuthorisesCall`
    // passing `voucher.payer` as the signer, and by `require(signer ==
    // voucher.payer)` on chain.
    expect(adapter.verifyVoucherSignature(voucher, forged, attacker.account)).toBe(true);
    expect(attacker.account).not.toBe(voucher.payer);
  });

  it('is byte-compatible with a wallet: viem’s own signTypedData verifies', async () => {
    // An INDEPENDENT producer. `buildVoucherMessage` builds the digest through
    // `hashTypedData`; this signs the typed data through viem's account API,
    // which walks its own encoder and its own `0x1901` framing. If the adapter
    // hashed something a wallet would not, the two disagree here — and that
    // disagreement is exactly the failure mode where every buyer signs bytes no
    // deployed contract will accept.
    const account = privateKeyToAccount(payer.privateKey);
    const signature = await account.signTypedData({
      domain: {
        name: EVM_DOMAIN_NAME,
        version: EVM_DOMAIN_VERSION,
        chainId: 46_630,
        verifyingContract: getAddress(TESTNET_DEPLOYMENT.escrow),
      },
      types: VOUCHER_TYPES,
      primaryType: 'Voucher',
      message: {
        payer: payer.address,
        provider: getAddress('0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2'),
        amount: 10_000n,
        resourceHash: keccak256(Buffer.from(voucher.resource, 'utf8')),
        requestHash: `0x${'a3f1c0de'.repeat(8)}`,
        seq: 42n,
        issuedAt: 1_785_999_800n,
        expiresAt: 1_786_000_000n,
      },
    });

    expect(adapter.verifyVoucherSignature(voucher, signature, payer.account)).toBe(true);
  });

  it('refuses a malleated signature, so one approval has exactly one encoding', () => {
    // `(r, n - s)` with the parity flipped recovers to the SAME address —
    // it is a second valid 65-byte string over the same voucher. It cannot
    // double-spend (`seq` closes that on chain); what it breaks is any
    // off-chain idempotency keyed on the signature string, and
    // `payment_intents.voucher_signature` is such a key today.
    const r = genuine.slice(2, 66);
    const s = BigInt(`0x${genuine.slice(66, 130)}`);
    const v = Number.parseInt(genuine.slice(130, 132), 16);
    const malleated = `0x${r}${(secp256k1.CURVE.n - s).toString(16).padStart(64, '0')}${(v === 27
      ? 28
      : 27
    ).toString(16)}`;

    expect(malleated).not.toBe(genuine);
    expect(adapter.verifyVoucherSignature(voucher, malleated, payer.account)).toBe(false);
  });

  it.each([
    ['yParity 0 rather than v 27', '00'],
    ['yParity 1 rather than v 28', '01'],
    ['EIP-155 style v', '1d'],
    ['a v of zero bytes over', 'ff'],
  ])('refuses a recovery byte that is not 27 or 28: %s', (_label, byte) => {
    const altered = `${genuine.slice(0, 130)}${byte}`;
    expect(adapter.verifyVoucherSignature(voucher, altered, payer.account)).toBe(false);
  });

  it('refuses every small structured (r, s) — the shape fuzzing never draws', () => {
    // Measured elsewhere in this codebase: a `_recover` with an `r == 0 && s == 2`
    // backdoor survived 157 tests, and 512 uniform `bytes32` draws never produce
    // `s == 2`. A deterministic sweep of the small values does.
    const values = [0n, 1n, 2n, 3n, 4n, 7n, 27n, 28n, 255n];
    for (const r of values) {
      for (const s of values) {
        for (const v of [27, 28]) {
          const signature = `0x${r.toString(16).padStart(64, '0')}${s
            .toString(16)
            .padStart(64, '0')}${v.toString(16)}`;
          expect({
            r,
            s,
            v,
            verified: adapter.verifyVoucherSignature(voucher, signature, payer.account),
          }).toEqual({ r, s, v, verified: false });
        }
      }
    }
  });

  it('refuses a voucher whose payTo is not this deployment’s escrow, genuinely signed', () => {
    // The adapter must assert `payTo` is the escrow. Here it is
    // enforced twice over: the digest is built under `payTo` as the
    // `verifyingContract` — so a wrong one is signed against a contract that
    // does not exist — AND the platform refuses to treat it as valid.
    const elsewhere: Voucher = {
      ...voucher,
      payTo: `${TESTNET}:0x1111111111111111111111111111111111111111` as AccountId,
    };
    const signedForElsewhere = payer.sign(adapter.buildVoucherMessage(elsewhere));

    expect(hex(adapter.buildVoucherMessage(elsewhere))).not.toBe(hex(digest));
    expect(adapter.verifyVoucherSignature(elsewhere, signedForElsewhere, payer.account)).toBe(
      false,
    );
  });

  it('binds the chain, so the same voucher on another EVM chain is other bytes', () => {
    // The same key controls the same address on every EVM chain. Without
    // `chainId` in the domain, a voucher signed for a testnet escrow verifies
    // against the mainnet escrow of the same buyer.
    const onOtherChain: Voucher = {
      ...voucher,
      payer: `${OTHER_CHAIN}:${payer.address}` as AccountId,
      payTo: `${OTHER_CHAIN}:${deployment(OTHER_CHAIN).escrow}` as AccountId,
      provider: `${OTHER_CHAIN}:0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2` as AccountId,
    };

    expect(hex(adapter.buildVoucherMessage(onOtherChain))).not.toBe(hex(digest));
    expect(
      adapter.verifyVoucherSignature(
        onOtherChain,
        genuine,
        `${OTHER_CHAIN}:${payer.address}` as AccountId,
      ),
    ).toBe(false);
  });
});

describe('the resource hash stored for redemption is the one the voucher signed', () => {
  // `VoucherService.record` stores it; `EvmVoucherRedeemer` replays it minutes
  // later as the struct's `resourceHash`, recomputing nothing. Storing the
  // sha256 Solana signs instead would make `ecrecover` answer a stranger.
  const stored = adapter.voucherResourceHash(voucher.resource);

  it('is keccak256 of the resource string, not sha256', () => {
    expect(`0x${stored}`).toBe(keccak256(stringToBytes(voucher.resource)));
  });

  it('rebuilds the exact digest the payer signed, from stored fields alone', () => {
    const replayed = hashVoucher(
      {
        payer: getAddress(voucher.payer.split(':')[2]),
        provider: getAddress(voucher.provider.split(':')[2]),
        amount: 10_000n,
        resourceHash: `0x${stored}`,
        requestHash: `0x${voucher.requestHash.replace(/^sha256:/, '')}`,
        seq: 42n,
        issuedAt: BigInt(voucher.issuedAt),
        expiresAt: BigInt(voucher.expiresAt),
      },
      evmDomain(TESTNET, getAddress(TESTNET_DEPLOYMENT.escrow)),
    );
    expect(replayed).toBe(`0x${hex(digest)}`);
  });
});

describe('the three signed structures cannot stand in for one another', () => {
  const challenge: PayoutProofChallenge = {
    account: payer.account,
    organizationId: 'org-11111111-1111-4111-8111-111111111111',
    nonce: 'd0dfc3aa6a49b2f2d69bb4f1a9d5f7c1d0dfc3aa6a49b2f2d69bb4f1a9d5f7c1',
    expiresAt: 1_786_000_000,
  };

  /**
   * The same four values, as the OTHER type.
   *
   * The two interfaces carry incompatible phantom brands so that a challenge
   * issued for one purpose cannot be passed to the other — structural typing
   * makes them one type without it. That is the property under test, so the
   * test has to build both rather than cast one into the other.
   */
  const stakeChallenge: StakeAuthorityChallenge = {
    account: challenge.account,
    organizationId: challenge.organizationId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
  };

  it('a payout proof and a stake-authority proof over identical fields are different bytes', () => {
    // Identical inputs on purpose: distinct bytes for obviously different
    // inputs proves nothing. The separation is the EIP-712 primary type, inside
    // the hashed preimage, doubled by the verifying contract — escrow for one,
    // stake for the other.
    expect(hex(adapter.buildPayoutProofMessage(challenge))).not.toBe(
      hex(adapter.buildStakeAuthorityMessage(stakeChallenge)),
    );
  });

  it('a genuine voucher signature is not a payout proof, and the reverse', () => {
    // The conformance suite crosses payout against stake. It never crosses
    // either against the voucher — which is the pair that actually moves money.
    const payoutSignature = payer.sign(adapter.buildPayoutProofMessage(challenge));

    expect(adapter.verifyPayoutProofSignature(challenge, genuine, payer.account)).toBe(false);
    expect(adapter.verifyVoucherSignature(voucher, payoutSignature, payer.account)).toBe(false);
    // Controls: each verifies under its own pair.
    expect(adapter.verifyPayoutProofSignature(challenge, payoutSignature, payer.account)).toBe(
      true,
    );
    expect(adapter.verifyVoucherSignature(voucher, genuine, payer.account)).toBe(true);
  });

  it('a genuine voucher signature is not a stake-authority proof, and the reverse', () => {
    const stakeSignature = payer.sign(adapter.buildStakeAuthorityMessage(stakeChallenge));

    expect(adapter.verifyStakeAuthoritySignature(stakeChallenge, genuine, payer.account)).toBe(
      false,
    );
    expect(adapter.verifyVoucherSignature(voucher, stakeSignature, payer.account)).toBe(false);
    expect(
      adapter.verifyStakeAuthoritySignature(stakeChallenge, stakeSignature, payer.account),
    ).toBe(true);
  });
});
