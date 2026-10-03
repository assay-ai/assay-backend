import { AccountId } from './caip.types';
import { Eip712Domain, Eip712Field } from './unsigned-chain-transaction';

/**
 * What an agent — a human, in a wallet pop-up — signs to prove they control
 * the wallet named as a provider's payout address.
 *
 * Deliberately its own struct, not a reuse of `Voucher` or
 * `WithdrawalAuthorization`. Both of those authorise a movement of value; this
 * one authorises nothing — it is a proof of key control, full stop. Collapsing
 * it into either would mean a signature obtained for "prove you own this
 * wallet" could be *shaped like* a payment or a withdrawal, and the console
 * copy is explicit that this is the one signature request on the platform that
 * must never be confusable with one that moves money.
 *
 * Every field is inside `SolanaChainAdapter.buildPayoutProofMessage`'s signed
 * bytes, in fixed order, newline-separated — see that method for the encoding
 * — and every field here is load-bearing:
 *
 * | Field | What tampering with it would buy an attacker |
 * |---|---|
 * | `account` | A signature over wallet A submitted to prove wallet B |
 * | `organizationId` | A proof minted for one tenant replayed onto another's provider row |
 * | `nonce` | The same signed proof accepted twice, or replayed after issue |
 * | `expiresAt` | A captured proof usable long after the console session that requested it |
 *
 * There is no leading version field on this interface, matching `Voucher` and
 * `WithdrawalAuthorization`: the version tag is not data the signer is
 * agreeing to, it is which *grammar* the rest of the bytes are written in, so
 * it lives as `PAYOUT_PROOF_MESSAGE_VERSION` in `solana.constants.ts` and is
 * prepended by `buildPayoutProofMessage` itself. See that constant for why it
 * must never collide with `WITHDRAWAL_MESSAGE_VERSION` or
 * `STAKE_AUTHORITY_MESSAGE_VERSION`.
 */
export interface PayoutProofChallenge {
  /**
   * Phantom brand — the counterpart to `StakeAuthorityChallenge.__brand`, and
   * the half of that brand that closes the second direction.
   *
   * That type carries the same four data fields as this one, so structurally
   * they are the same type and a challenge issued for one purpose is
   * assignable to the other. Branding only that side would stop a payout
   * proof being used as a stake-authority challenge, but not the reverse: a
   * value with an *extra* property is still assignable to a type without it.
   * Two brands with incompatible literal types are what make the two types
   * mutually unassignable.
   *
   * Never read, never written, never signed, and optional so that no code
   * building a challenge has to mention it. See `StakeAuthorityChallenge` for
   * the full rationale.
   */
  readonly __brand?: 'PayoutProofChallenge';
  /** CAIP-10. The wallet being claimed as the payout destination. */
  readonly account: AccountId;
  /** Whose provider row this proof, once verified, is written onto. */
  readonly organizationId: string;
  /**
   * 32 random bytes as lower-case hex (64 characters) — twice the width of a
   * voucher/withdrawal nonce. Those are spent within milliseconds of being
   * generated; this one is issued to a console session and may sit unused for
   * the whole of its TTL, so it is also the only defence against a nonce
   * being *guessed* rather than captured, and gets the wider margin.
   */
  readonly nonce: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/**
 * A provider proof as an EIP-712 signature request, on chains where the proof
 * IS typed data (eip155).
 *
 * `buildPayoutProofMessage` / `buildStakeAuthorityMessage` return the bytes a
 * verifier checks, and on eip155 those bytes are a 32-byte `hashTypedData`
 * digest — not something a wallet can be shown or asked to sign as a message.
 * Signing them as one (EIP-191) produces a signature that never recovers to
 * the signer. This is what the wallet is handed instead.
 *
 * Every integer in `message` is a decimal string, and `domain.chainId` is one
 * too, so the request survives JSON — the convention
 * `Eip155TypedDataRequestDto` already follows. Unlike that member it carries
 * no `relayed`: nobody submits a proof; the signature is the whole product.
 */
export interface ProofTypedData {
  readonly domain: Eip712Domain;
  readonly types: Record<string, readonly Eip712Field[]>;
  readonly primaryType: string;
  readonly message: Record<string, string>;
}
