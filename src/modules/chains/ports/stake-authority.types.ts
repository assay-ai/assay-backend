import { AccountId } from './caip.types';

/**
 * What a provider — a human, in a wallet pop-up — signs to prove they control
 * the wallet that opened their on-chain stake account.
 *
 * Deliberately its own struct, and specifically **not** a reuse or a
 * re-export of `PayoutProofChallenge`, even though the four data fields are
 * currently identical. That interface makes the same argument about not
 * collapsing into `Voucher`, and it applies with more force here, because
 * these two are the closest pair on the platform: both are proofs of key
 * control, differing only in what the proved key is then trusted with. Two
 * structs also mean the two can diverge (a stake link may one day need the
 * stake PDA or the chain id) without a migration of the other.
 *
 * Declaring them separately is **not on its own** enough to keep them apart.
 * TypeScript is structurally typed: two interfaces with identical members are
 * the same type, so before the `__brand` below existed, both of these
 * compiled clean —
 *
 * ```typescript
 * const a: StakeAuthorityChallenge = somePayoutProofChallenge;
 * const b: PayoutProofChallenge = someStakeAuthorityChallenge;
 * ```
 *
 * — and the only real separation was the version tag inside the built bytes,
 * a runtime property checked in one adapter. The phantom brand is what makes
 * the separation a fact the compiler holds; see the field for why it is
 * shaped the way it is.
 *
 * Every field is inside `SolanaChainAdapter.buildStakeAuthorityMessage`'s
 * signed bytes, in fixed order, newline-separated — see that method for the
 * encoding — and every field here is load-bearing. What tampering buys an
 * attacker is *not* what it buys on a payout proof: a payout proof, forged,
 * redirects the forger's own earnings, and the money at risk is theirs. Here
 * the asset being claimed is a **stranger's collateral**:
 *
 * | Field | What tampering with it would buy an attacker |
 * |---|---|
 * | `account` | A signature over their own wallet submitted as proof for someone else's stake pubkey — clearing the router's stake gate on collateral they do not own, and pointing every slash attestation for their defection at the victim's PDA |
 * | `organizationId` | A genuine proof of one org's stake wallet replayed onto a second org's provider row, so one stake account backs two providers and the same collateral is counted twice |
 * | `nonce` | The same signed proof accepted twice — including after the wallet has been unstaked, sold, or its stake withdrawn |
 * | `expiresAt` | A proof captured from an old console session used to (re)attach a stake authority long after the operator who approved it stopped controlling that wallet |
 *
 * There is no leading version field on this interface, matching `Voucher`,
 * `WithdrawalAuthorization` and `PayoutProofChallenge`: the version tag is not
 * data the signer is agreeing to, it is which *grammar* the rest of the bytes
 * are written in, so it lives as `STAKE_AUTHORITY_MESSAGE_VERSION` in
 * `solana.constants.ts` and is prepended by `buildStakeAuthorityMessage`
 * itself. See that constant for why it must never collide with the other
 * three, and `PAYOUT_PROOF_MESSAGE_VERSION` in particular.
 */
export interface StakeAuthorityChallenge {
  /**
   * Phantom brand. Never read, never written, never signed — it exists only
   * so that this type and `PayoutProofChallenge` stop being mutually
   * assignable, which structural typing otherwise makes them.
   *
   * `__brand` is the codebase's branding idiom (`ChainId`, `AccountId`,
   * `AssetId`, `TxRef` in `caip.types.ts` / `x402.types.ts`), carried over
   * from branded strings to a branded struct.
   *
   * Three shape decisions, each of which the obvious alternative gets wrong:
   *
   * - **A brand, not a real `purpose` field.** A real field would raise the
   *   question of whether it belongs in the signed bytes — it does not, the
   *   version tag already states purpose *inside* the signature — and would
   *   leave a second, independently-writable copy of something the tag
   *   already says. Two sources of truth for purpose is exactly the confusion
   *   this type exists to prevent.
   * - **Optional, so no call site has to write it.** A required brand would
   *   force `as` casts (or a dummy value) at every literal that builds a
   *   challenge, and a cast at a call site is a cast that can be aimed at the
   *   wrong type.
   * - **Matched by a counterpart on `PayoutProofChallenge`.** One-sided does
   *   not work: an extra property is fine when assigning to a type that lacks
   *   it, so branding only this side would still let a stake challenge be
   *   passed as a payout proof. It takes two incompatible literal types to
   *   close both directions.
   */
  readonly __brand?: 'StakeAuthorityChallenge';
  /** CAIP-10. The wallet being claimed as the opener of the stake account. */
  readonly account: AccountId;
  /** Whose provider row this proof, once verified, is written onto. */
  readonly organizationId: string;
  /**
   * 32 random bytes as lower-case hex (64 characters) — the payout proof's
   * width, not a voucher's, and for the same reason: this nonce is issued to
   * a console session and may sit unused for the whole of its TTL, so it is
   * also the only defence against a nonce being *guessed* rather than
   * captured.
   */
  readonly nonce: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}
