/**
 * The bytes a provider signs to prove they control the wallet that opened
 * their on-chain stake account.
 *
 * The fourth signed structure on the platform, and the one whose confusion
 * risk is highest: `PayoutProofChallenge` and `StakeAuthorityChallenge` carry
 * the *same four data fields* — they differ only in a phantom brand, which
 * the compiler sees and the bytes do not — so the only thing separating
 * "this wallet is where you send my earnings" from "this wallet is the
 * collateral I am staking behind my tools" is the version tag leading the
 * message.
 *
 * Two things in here carry that separation, and it is worth being exact about
 * which one carries what, because the obvious reading of the pair below is
 * wrong:
 *
 * - **The two cross-verification directions** are the direct, readable
 *   assertion that a signature collected for one purpose does not satisfy the
 *   other's check. They are what fails — loudly, three tests at once — if the
 *   two tags are ever made equal. Keep them.
 * - **They do not catch a tag that is a *prefix* of another**, and no second
 *   direction could. The tag leads the message and is newline-delimited, so
 *   two built messages are equal exactly when their tags are; the two
 *   directions are therefore logically equivalent, and a prefix is invisible
 *   to both. This was measured, not reasoned: with
 *   `STAKE_AUTHORITY_MESSAGE_VERSION` set to `'assay-payout-proof/v1X'` the
 *   whole unit suite fails in exactly one place — the `not.toContain`
 *   assertion in `leads the message with the version tag` below.
 *
 * So the prefix case has exactly one cover, and it is an assertion that looks
 * redundant next to the `startsWith` above it. It is not. See the comment on
 * it before removing it.
 *
 * What is at stake if the separation fails is not this provider's money but
 * *someone else's*: a stake-authority link is what the router's stake gate
 * reads and what a slash attestation points at. A provider who can attach a
 * pubkey they do not control clears the gate on a stranger's collateral, and
 * the stranger pays for their defection.
 */
import { generateKeyPairSync, sign } from 'node:crypto';

import { getBase58Decoder } from '@solana/kit';

import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { PayoutProofChallenge } from '@modules/chains/ports/payout-proof.types';
import { StakeAuthorityChallenge } from '@modules/chains/ports/stake-authority.types';
import {
  PAYOUT_PROOF_MESSAGE_VERSION,
  STAKE_AUTHORITY_MESSAGE_VERSION,
} from '@modules/chains/solana/solana.constants';
import { SolanaChainAdapter, SolanaRpcClient } from '@modules/chains/solana/solana-chain.adapter';

const SOLANA_MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const OTHER_ADDRESS = 'C4PRXFV6Gf5mytVZb6RoeLsG8CjcFWzR2EJ3dvwPTUJH';

function stubRpc(): SolanaRpcClient {
  return {
    getTokenAccountBalance: () => ({
      send: async () => ({ value: { amount: '0', decimals: 6 } }),
    }),
    getTransaction: () => ({
      send: async () => null,
    }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0n },
      }),
    }),
  } as SolanaRpcClient;
}

describe('SolanaChainAdapter — stake authority proof', () => {
  const keyPair = generateKeyPairSync('ed25519');
  const rawPublicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const signerAddress = getBase58Decoder().decode(rawPublicKey);
  const account = `${SOLANA_MAINNET}:${signerAddress}` as AccountId;

  let adapter: SolanaChainAdapter;

  beforeEach(() => {
    adapter = new SolanaChainAdapter(stubRpc(), [
      CHAIN_IDS.SOLANA_MAINNET,
      CHAIN_IDS.SOLANA_DEVNET,
    ]);
  });

  const challenge: StakeAuthorityChallenge = {
    account,
    organizationId: 'org-11111111-1111-4111-8111-111111111111',
    nonce: '9c1e77aa3b40f5d2e6ab88c4f10d5b739c1e77aa3b40f5d2e6ab88c4f10d5b73',
    expiresAt: 1_786_000_000,
  };

  /**
   * The same four fields, read as the *other* challenge type. Not a cast of
   * one interface to the other — the point of the cross-verification tests is
   * that two independently declared structures with identical field values
   * still produce non-interchangeable signatures.
   */
  const asPayoutChallenge: PayoutProofChallenge = {
    account: challenge.account,
    organizationId: challenge.organizationId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
  };

  const signWith =
    (privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) => (message: Uint8Array) =>
      getBase58Decoder().decode(sign(null, Buffer.from(message), privateKey));

  const signAsSigner = signWith(keyPair.privateKey);

  const signChallenge = (c: StakeAuthorityChallenge) =>
    signAsSigner(adapter.buildStakeAuthorityMessage(c));

  it('leads the message with the version tag', () => {
    const text = new TextDecoder().decode(adapter.buildStakeAuthorityMessage(challenge));
    expect(text.startsWith('assay-stake-authority/v1\n')).toBe(true);
    expect(text.startsWith(STAKE_AUTHORITY_MESSAGE_VERSION)).toBe(true);
    // Load-bearing, and the reason to leave it alone: this is the ONLY
    // assertion in the suite that catches a tag which is a prefix of another
    // one. The two cross-verification tests below cannot — equal messages
    // require equal tags, so both directions stay green while
    // STAKE_AUTHORITY_MESSAGE_VERSION is 'assay-payout-proof/v1X'. This line
    // is the one that goes red.
    expect(text).not.toContain(PAYOUT_PROOF_MESSAGE_VERSION);
    // Voucher v2 carries its domain tag in the client's `voucherMessage`, not
    // here — 240 fixed-width bytes under `b"assay:voucher:v2"`.
    expect(text).not.toContain('assay:voucher:v2');
  });

  it('verifies a genuine stake-authority signature', () => {
    expect(
      adapter.verifyStakeAuthoritySignature(challenge, signChallenge(challenge), account),
    ).toBe(true);
  });

  // ── The two decisive directions ────────────────────────────────────────

  it('does not verify a payout-proof signature as a stake-authority proof', () => {
    const payoutSig = signAsSigner(adapter.buildPayoutProofMessage(asPayoutChallenge));
    expect(adapter.verifyStakeAuthoritySignature(challenge, payoutSig, account)).toBe(false);
  });

  it('does not verify a stake-authority signature as a payout proof', () => {
    const stakeSig = signAsSigner(adapter.buildStakeAuthorityMessage(challenge));
    expect(adapter.verifyPayoutProofSignature(asPayoutChallenge, stakeSig, account)).toBe(false);
  });

  // ── One case per field ─────────────────────────────────────────────────

  it('rejects a signature over a different account', () => {
    const signature = signChallenge(challenge);
    const tampered = { ...challenge, account: `${SOLANA_MAINNET}:${OTHER_ADDRESS}` as AccountId };
    expect(adapter.verifyStakeAuthoritySignature(tampered, signature, account)).toBe(false);
  });

  it('rejects a signature over a different organization id', () => {
    const signature = signChallenge(challenge);
    const tampered = {
      ...challenge,
      organizationId: 'org-22222222-2222-4222-8222-222222222222',
    };
    expect(adapter.verifyStakeAuthoritySignature(tampered, signature, account)).toBe(false);
  });

  it('rejects a signature over a different nonce', () => {
    const signature = signChallenge(challenge);
    const tampered = { ...challenge, nonce: 'f'.repeat(64) };
    expect(adapter.verifyStakeAuthoritySignature(tampered, signature, account)).toBe(false);
  });

  it('rejects a signature over a different expiry', () => {
    const signature = signChallenge(challenge);
    const tampered = { ...challenge, expiresAt: challenge.expiresAt + 3600 };
    expect(adapter.verifyStakeAuthoritySignature(tampered, signature, account)).toBe(false);
  });

  // ── The wrong wallet, and garbage ──────────────────────────────────────

  it('rejects a genuine signature made by a wallet other than the one claimed', () => {
    const attacker = generateKeyPairSync('ed25519');
    const attackerSignature = signWith(attacker.privateKey)(
      adapter.buildStakeAuthorityMessage(challenge),
    );
    expect(adapter.verifyStakeAuthoritySignature(challenge, attackerSignature, account)).toBe(
      false,
    );
  });

  it('rejects a malformed signature rather than throwing', () => {
    expect(adapter.verifyStakeAuthoritySignature(challenge, 'not-a-signature', account)).toBe(
      false,
    );
  });
});
