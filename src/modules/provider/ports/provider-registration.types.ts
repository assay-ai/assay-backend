import { AccountId, ChainId } from '@modules/chains/ports/caip.types';

/**
 * The registration record — open registration, the wallet-proved payout
 * address, the `verified` label and the connectivity check.
 *
 * Deliberately separate from {@link ProviderRoutingState} in `provider.types.ts`.
 * That type is what a *routing decision* reads, and it stays free of company
 * identity so that every routing test can build a provider without inventing a
 * legal entity. This file is the other half: who the counterparty is, how to
 * reach a human there, which wallet has been *proved*, and whether anyone has
 * checked any of it.
 *
 * ## `providerId` is still `organizationId`
 *
 * `ProviderProfileService` documents this assumption as the module's core, and
 * open registration was expected to be where it would stop being one. It does
 * not stop here, and that is a decision rather than an omission: `payment_intents.
 * provider_id`, `tool_bindings.providerId` and both seeded ports key on an
 * opaque id that today *is* the organization id, so minting a second id would
 * mean a backfill of live tables plus a rewrite of the router's key, for no
 * behaviour anybody asked for. What changes here is that the id now names a
 * real row: `providers.organization_id` is `UNIQUE`, so one organization is
 * exactly one provider, and the id is a key into a table instead of a
 * convention. See `providers.entity.ts`.
 */

/**
 * A person, not a mailbox string.
 *
 * An operational notice has to reach a human. A single
 * free-text field satisfies a form and fails that: `ops@` with nobody behind it
 * validates as an email, and the first thing anyone learns about it is that a
 * 72-hour dispute clock ran out against a mailbox no one reads. Naming the person is what
 * makes the record auditable afterwards — "who did we tell, and how" has an
 * answer.
 */
export interface ProviderContact {
  /** The human. Not a team, not a role alias — "Technical contact" is one name. */
  readonly name: string;
  readonly email: string;
  /** Optional second channel for the incidents that email loses. */
  readonly phone?: string | null;
}

/**
 * What was accepted, and which text of it.
 *
 * Three documents rather than one, because they change on different clocks: the
 * slash policy is the one that will move (real slashing is gated on a
 * measured false-positive rate), and re-consenting a provider to the payout
 * terms because the slash policy changed is how consent records stop meaning
 * anything. `acceptedAt` and `acceptedBy` are what make this a record of an act
 * rather than three strings.
 */
export interface AcceptedTerms {
  readonly providerAgreementVersion: string;
  readonly payoutTermsVersion: string;
  readonly slashPolicyVersion: string;
  /** ISO-8601, UTC. */
  readonly acceptedAt: string;
  /** The console credential that clicked accept — `session.credentialId`. */
  readonly acceptedBy: string;
}

/**
 * The proof that a wallet named on a provider row is controlled by whoever
 * registered it.
 *
 * Console only. The stored artefact is the *challenge id*, not the
 * message — the message lives on `provider_payout_challenges` and is never
 * rebuilt from client input, because a verifier that re-derives the signed
 * bytes from a request body verifies whatever the request body says.
 *
 * ## Two columns, one envelope
 *
 * The stake-authority proof is stored in this same shape
 * (`providers.stake_proof`), and `challengeId` still points into
 * `provider_payout_challenges` because that flow reuses the table —
 * `message_version` there is the column that says which of the two kinds of
 * challenge the row is. The statement above therefore remains true of every
 * `PayoutProof` on the platform, and the table name stays accurate for both.
 *
 * There is deliberately no `purpose: 'PAYOUT' | 'STAKE_AUTHORITY'` field.
 * Three reasons, in order of weight:
 *
 * 1. **{@link messageVersion} already says it, and says it better.** The tag
 *    is inside the bytes the wallet signed, so it cannot be edited after the
 *    fact without invalidating the signature. A `purpose` field would be a
 *    second, independently-writable copy of the same fact — and when a copy
 *    disagrees with the signed original, the original wins, which makes the
 *    copy something to reconcile rather than something to trust.
 * 2. **The column is the discriminator.** A stake proof lives in
 *    `stake_proof`, a payout proof in `payout_proof`, and each column's trio
 *    is held together by its own CHECK. A field inside the JSON adds nothing a
 *    reader does not already know from where they found it.
 * 3. **It would be a required field that historical rows lack.** Every
 *    `payout_proof` written so far has four keys; typing a fifth as
 *    non-optional would have the compiler assert something false about every
 *    one of them until a backfill said otherwise.
 *
 * Two structurally identical *types* — `PayoutProof` and a `StakeAuthorityProof`
 * with the same four fields — were the other option, and buy nothing:
 * TypeScript is structural, so the two would be mutually assignable and the
 * name would be the whole of the difference. Branding them apart would make
 * the split real, and is worth revisiting only if the two envelopes ever
 * genuinely diverge.
 */
export interface PayoutProof {
  readonly challengeId: string;
  /** base58, as the wallet returned it. */
  readonly signature: string;
  /**
   * Version tag that led the signed message, so an old proof stays checkable —
   * and what distinguishes a payout proof
   * (`assay-payout-proof/v1`) from a stake-authority proof
   * (`assay-stake-authority/v1`).
   */
  readonly messageVersion: string;
  /** ISO-8601, UTC. */
  readonly provedAt: string;
}

/** How a payout address may be submitted. There is exactly one member, on purpose. */
export enum PayoutProofChannel {
  /**
   * The signed-in console, and nothing else.
   *
   * Only in the console, never over email or a ticket. An address
   * accepted over email, a CLI or a support ticket is a phishing surface: the
   * attack is a plausible message to support, and the loss is every future
   * payout. The enum has one member so that adding a second is a diff someone
   * has to defend, rather than a string a call site can pass.
   */
  CONSOLE = 'CONSOLE',
}

/** What a connectivity probe concluded. */
export enum ConnectivityOutcome {
  /** The endpoint answered. Any HTTP status — see {@link ConnectivityCheckResult}. */
  REACHABLE = 'REACHABLE',
  /** We reached the network and got nothing usable: DNS, TLS, timeout, reset. */
  UNREACHABLE = 'UNREACHABLE',
  /**
   * The egress guard refused to dial it at all — private address, loopback,
   * cloud metadata, or a scheme we do not speak. The egress guard decided this
   * before a packet left.
   */
  BLOCKED = 'BLOCKED',
}

/**
 * One probe, as the console renders it (onboarding step 3).
 *
 * `reachable` is *not* `status < 400`. A provider endpoint that answers `401`
 * has proved the only thing this check exists to prove — that the address
 * resolves, the TLS handshake completes, and something is listening from our
 * egress IPs. Grading their auth here would fail every correctly-secured
 * endpoint on the platform.
 */
export interface ConnectivityCheckResult {
  readonly outcome: ConnectivityOutcome;
  readonly endpoint: string;
  readonly statusCode: number | null;
  readonly latencyMs: number | null;
  /** `EgressFailureKind`, when there was one. */
  readonly failureKind: string | null;
  /** `EGRESS_*` code, when there was one. */
  readonly failureCode: string | null;
  readonly detail: string | null;
  /** ISO-8601, UTC. */
  readonly checkedAt: string;
}

/**
 * The `verified` label.
 *
 * A flag alone is a claim with no author. What a buyer needs is *who* checked
 * and *what* they checked, so the label can be weighed rather than believed;
 * that is why `checks` is a list of named findings and `verifiedBy` is a
 * required string on every verified profile.
 *
 * **It is not a gate.** Nothing in registration, publishing or routing reads
 * it. Registration is open, and the publish check gates publishing on a green
 * tester and sufficient stake — neither consults this. Wiring it into either
 * would quietly convert an informational label into the approval step open
 * registration exists to remove.
 */
export interface ProviderVerificationProfile {
  readonly verified: boolean;
  /** Who performed the check. Null exactly when `verified` is false. */
  readonly verifiedBy: string | null;
  /** ISO-8601, UTC. Null exactly when `verified` is false. */
  readonly verifiedAt: string | null;
  /** How it was done — `DOCUMENT_REVIEW`, `DOMAIN_CONTROL`, `PARTNER_ATTESTATION`, … */
  readonly method: string | null;
  /** What was actually checked. An empty list on a verified provider is a bug. */
  readonly checks: readonly ProviderVerificationCheck[];
  /**
   * When the label lapses, if it does.
   *
   * A legal-entity check is a statement about a moment. Nullable because some
   * checks genuinely do not expire, but present so that "verified in 2024" can
   * stop being served as "verified".
   */
  readonly expiresAt: string | null;
  /** Optional pointer to the evidence, for a buyer who wants to look. */
  readonly evidenceUrl: string | null;
}

/** One named finding inside a {@link ProviderVerificationProfile}. */
export interface ProviderVerificationCheck {
  /** `LEGAL_ENTITY`, `DOMAIN_CONTROL`, `PAYOUT_ADDRESS_PROOF`, … */
  readonly check: string;
  readonly result: 'PASS' | 'FAIL' | 'NOT_CHECKED';
  readonly note: string | null;
}

/** The unverified profile, which is what every provider has at registration. */
export const UNVERIFIED_PROFILE: ProviderVerificationProfile = Object.freeze({
  verified: false,
  verifiedBy: null,
  verifiedAt: null,
  method: null,
  checks: Object.freeze([]) as readonly ProviderVerificationCheck[],
  expiresAt: null,
  evidenceUrl: null,
});

/** One chain a provider is enrolled on, and the address proved for it. */
export interface ProviderPayoutAccount {
  readonly chainId: ChainId;
  readonly accountId: AccountId;
  readonly proof: PayoutProof;
  readonly provedAt: string;
}

/** Where a provider is in the four-step onboarding setup. */
export enum OnboardingStepStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE = 'DONE',
}
