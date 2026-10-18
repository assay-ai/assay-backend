import { RELAY_ALLOWED_PORTS } from '@shared/network/egress';
import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `PROVIDER_*` — open registration, payout proof, stake lifecycle and the
 * publish gate.
 */
export enum ProviderErrorCode {
  PROVIDER_NOT_FOUND = 'PROVIDER_NOT_FOUND',
  PROVIDER_ALREADY_REGISTERED = 'PROVIDER_ALREADY_REGISTERED',
  PROVIDER_SUSPENDED = 'PROVIDER_SUSPENDED',
  PROVIDER_PAYOUT_ADDRESS_UNPROVEN = 'PROVIDER_PAYOUT_ADDRESS_UNPROVEN',
  /** `POST /providers/me/payout-address` — no challenge by that id belongs to the caller. */
  PROVIDER_PAYOUT_CHALLENGE_NOT_FOUND = 'PROVIDER_PAYOUT_CHALLENGE_NOT_FOUND',
  /** The nonce timed out. Issue another; never extend one. */
  PROVIDER_PAYOUT_CHALLENGE_EXPIRED = 'PROVIDER_PAYOUT_CHALLENGE_EXPIRED',
  /** A nonce is spent once. A second submission is a replay, whoever sent it. */
  PROVIDER_PAYOUT_CHALLENGE_ALREADY_USED = 'PROVIDER_PAYOUT_CHALLENGE_ALREADY_USED',
  /** The signature does not verify against the challenged address. */
  PROVIDER_PAYOUT_SIGNATURE_INVALID = 'PROVIDER_PAYOUT_SIGNATURE_INVALID',
  /** The connectivity check was asked to probe an endpoint the provider never declared. */
  PROVIDER_ENDPOINT_NOT_DECLARED = 'PROVIDER_ENDPOINT_NOT_DECLARED',
  /** The two contacts share an inbox, or a required contact field is missing. */
  PROVIDER_CONTACTS_NOT_DISTINCT = 'PROVIDER_CONTACTS_NOT_DISTINCT',
  /** `timezone` is not an IANA zone this runtime knows. */
  PROVIDER_TIMEZONE_UNKNOWN = 'PROVIDER_TIMEZONE_UNKNOWN',
  /** The accepted terms name a version that is not the one currently published. */
  PROVIDER_TERMS_VERSION_MISMATCH = 'PROVIDER_TERMS_VERSION_MISMATCH',
  PROVIDER_CONNECTIVITY_CHECK_FAILED = 'PROVIDER_CONNECTIVITY_CHECK_FAILED',
  /** Too many tester runs or connectivity checks — in flight, or in the last minute. */
  PROVIDER_EGRESS_RATE_LIMITED = 'PROVIDER_EGRESS_RATE_LIMITED',
  PROVIDER_STAKE_NOT_FOUND = 'PROVIDER_STAKE_NOT_FOUND',
  PROVIDER_STAKE_BELOW_MINIMUM = 'PROVIDER_STAKE_BELOW_MINIMUM',
  /**
   * The stake-authority proof's own five codes.
   *
   * Deliberately not the `PROVIDER_PAYOUT_CHALLENGE_*` codes, even though the
   * two flows share the `provider_payout_challenges` table and the same five
   * steps. A code is what a console and an on-call engineer branch on, and
   * these two failures need different remedies: a rejected payout proof costs
   * the provider their own next payout, while a rejected stake proof means the
   * router will not send them paid traffic at all. Sharing a code would also
   * mean a log line saying `PROVIDER_PAYOUT_SIGNATURE_INVALID` for a flow with
   * no payout in it, which is the kind of thing that sends an incident down
   * the wrong path.
   */
  PROVIDER_STAKE_CHALLENGE_NOT_FOUND = 'PROVIDER_STAKE_CHALLENGE_NOT_FOUND',
  /** The nonce timed out. Issue another; never extend one. */
  PROVIDER_STAKE_CHALLENGE_EXPIRED = 'PROVIDER_STAKE_CHALLENGE_EXPIRED',
  /** A nonce is spent once. A second submission is a replay, whoever sent it. */
  PROVIDER_STAKE_CHALLENGE_ALREADY_USED = 'PROVIDER_STAKE_CHALLENGE_ALREADY_USED',
  /** The signature does not verify against the challenged stake authority. */
  PROVIDER_STAKE_SIGNATURE_INVALID = 'PROVIDER_STAKE_SIGNATURE_INVALID',
  /** `uq_provider_chain_enrolments_stake_authority` fired — another provider proved this account first. */
  PROVIDER_STAKE_AUTHORITY_ALREADY_CLAIMED = 'PROVIDER_STAKE_AUTHORITY_ALREADY_CLAIMED',
  /**
   * The authority may not move while the account it currently names
   * still holds slashable collateral.
   *
   * The backend derives the stake PDA from `providers.stake_authority` at the
   * moment it needs it, and one of those moments is building a slash
   * attestation. Without this, a provider watching a verdict form could
   * re-prove a fresh pubkey, the attestation would name that pubkey's empty
   * PDA, and the collateral would sit untouched in the old account until the
   * unbonding period let them withdraw it. "Defecting costs more than it earns"
   * is the premise the whole stake gate rests on, and free rotation is what
   * makes it false.
   */
  PROVIDER_STAKE_AUTHORITY_STILL_FUNDED = 'PROVIDER_STAKE_AUTHORITY_STILL_FUNDED',
  /**
   * The same rule from the other side: the gate could not read the chain, so
   * it refused.
   *
   * A separate code from the refusal above because the two need opposite
   * things from whoever reads them. `..._STILL_FUNDED` is the provider's to
   * fix — exit the account. This one is nobody's to fix from the console: the
   * platform could not prove the account is empty, and an account it cannot
   * read is never treated as an empty one. Without a code of its own the same
   * event surfaced as a bare `500 Internal server error`, which is fail-closed
   * that nobody can act on.
   */
  PROVIDER_STAKE_AUTHORITY_CHECK_UNAVAILABLE = 'PROVIDER_STAKE_AUTHORITY_CHECK_UNAVAILABLE',
  /**
   * A stake intent was asked for by a provider who has never
   * proved a stake authority.
   *
   * Not `PROVIDER_STAKE_NOT_FOUND`, which is about a *balance* nobody could
   * read. This one is about the link itself: there is no pubkey to derive a
   * `ProviderStake` PDA from, so there is no transaction to build and nothing
   * to build it for. The remedy is the challenge/prove flow, and the message
   * names it — a provider who reads "stake not found" goes looking for money.
   */
  PROVIDER_STAKE_AUTHORITY_UNPROVEN = 'PROVIDER_STAKE_AUTHORITY_UNPROVEN',
  /**
   * A stake authority was proved for a chain this provider has no enrolment on.
   *
   * The enrolment is the row the stake authority is a column ON, so there is
   * nowhere to write it — but the reason it is refused rather than created is
   * a design decision, not the schema: an enrolment declares *where you get
   * paid*, and staking on a chain with no payout address would put collateral
   * behind calls whose earnings have nowhere to go. Prove a payout address on
   * that chain first.
   */
  PROVIDER_CHAIN_NOT_ENROLLED = 'PROVIDER_CHAIN_NOT_ENROLLED',
  /**
   * This provider has proved a stake authority on more than one chain, and the
   * endpoint asked has no field naming which one.
   *
   * A refusal rather than a pick. The stake intents build bytes a wallet is
   * about to sign against one `ProviderStake` PDA, and choosing "the first
   * enrolment" would hand a provider a transaction against a chain they were
   * not looking at. The remedy is a `chainId` on the request, which is a route
   * change and is not made yet, rather than guessed at here.
   */
  PROVIDER_STAKE_AUTHORITY_AMBIGUOUS = 'PROVIDER_STAKE_AUTHORITY_AMBIGUOUS',
  /**
   * A chain in `ENABLED_CHAINS` has no minimum-stake floor.
   *
   * Raised by the `ROUTER_CONFIG` factory at **boot**, never per request: a
   * missing floor is a misconfiguration, and discovering it as a
   * per-call `STAKE_UNKNOWN` would look like an RPC outage — an operator would
   * go and check the chain rather than the environment. `500` because nothing
   * about any request is wrong.
   *
   * **No configuration currently satisfies it for two chains**, and the message
   * says so rather than sending the operator round a loop.
   * `loadMinimumStakeParameters` reads ONE `PLATFORM_STAKE_ASSET_ID` and ONE
   * `PROVIDER_MINIMUM_STAKE_FLOOR`, so the map it builds has exactly one entry:
   * naming chain B's asset just moves the failure to chain A. That is the
   * intended hard stop — the alternative is a deployment quietly serving paid
   * calls on a chain whose collateral it cannot price — and the remedy is a
   * per-chain floor surface, which does not exist yet.
   */
  PROVIDER_MINIMUM_STAKE_UNCONFIGURED = 'PROVIDER_MINIMUM_STAKE_UNCONFIGURED',
  /**
   * `open-stake-intent` on an account that already has a `ProviderStake` PDA.
   *
   * Refused here rather than left to the program, which would also refuse it —
   * `open_stake` is deliberately not `init_if_needed`, because *"an initializer
   * that can run on an existing account is the shape reinitialisation attacks
   * are made of"*. Letting it through would cost the provider a network fee to
   * learn what this endpoint already knew, and would look to them like a
   * platform bug rather than an already-finished step.
   */
  PROVIDER_STAKE_ACCOUNT_ALREADY_OPEN = 'PROVIDER_STAKE_ACCOUNT_ALREADY_OPEN',
  /**
   * A deposit, unstake or withdrawal against an account that was never opened.
   *
   * `deposit_stake` and its two siblings take an already-existing
   * `Account<'info, ProviderStake>`, so this is not a recoverable state on
   * chain: the provider has to run `open-stake-intent` first. The ordering is
   * the one thing about this flow that surprises people, so the code says which
   * step is missing rather than reporting a generic conflict.
   */
  PROVIDER_STAKE_ACCOUNT_NOT_OPEN = 'PROVIDER_STAKE_ACCOUNT_NOT_OPEN',
  PROVIDER_STAKE_ACCOUNT_NOT_NEEDED = 'PROVIDER_STAKE_ACCOUNT_NOT_NEEDED',
  /**
   * The chain could not be read, so no stake intent was built.
   *
   * A sibling of `PROVIDER_STAKE_AUTHORITY_CHECK_UNAVAILABLE` and a separate
   * code for the same reason that one is separate: both are `503`s that fail
   * closed, and an on-call engineer needs to know which flow stopped. This one
   * costs a provider a retry; that one costs them a key rotation.
   *
   * Fail closed rather than degrade, because every honest answer here depends
   * on the chain. A preflight that reported "0 USDC" because the RPC was down
   * would send a provider to a faucet they do not need, and a transaction built
   * without reading `Config.stake_mint` would be a transfer of a guessed token.
   */
  PROVIDER_STAKE_CHAIN_UNAVAILABLE = 'PROVIDER_STAKE_CHAIN_UNAVAILABLE',
  PROVIDER_PUBLISH_CHECKS_FAILED = 'PROVIDER_PUBLISH_CHECKS_FAILED',
  /** `GET /providers/me/tool-bindings/:id` — no binding by this id belongs to the caller. */
  PROVIDER_BINDING_NOT_FOUND = 'PROVIDER_BINDING_NOT_FOUND',
  /** `POST /providers/me/tool-bindings` — this provider already implements that tool. */
  PROVIDER_BINDING_ALREADY_EXISTS = 'PROVIDER_BINDING_ALREADY_EXISTS',
  /**
   * T3: the binding's contract range or declared optional fields do not fit
   * the contract — a major with no published version, a field that is not
   * an optional field of the contract, an input the request mapping never
   * reads, or a tester version outside the range.
   */
  PROVIDER_BINDING_CONTRACT_MISMATCH = 'PROVIDER_BINDING_CONTRACT_MISMATCH',
  /** The `toolId` names no tool in the catalogue. A binding needs a contract to map onto. */
  PROVIDER_BINDING_TOOL_UNKNOWN = 'PROVIDER_BINDING_TOOL_UNKNOWN',
  /** `PATCH`/`POST …/publish` on a `SUSPENDED` binding — the platform took it down. */
  PROVIDER_BINDING_NOT_EDITABLE = 'PROVIDER_BINDING_NOT_EDITABLE',
  /** `POST …/publish` when the live revision is already the current one. */
  PROVIDER_BINDING_ALREADY_PUBLISHED = 'PROVIDER_BINDING_ALREADY_PUBLISHED',
  /**
   * The pause button's three refusals, and they are three codes
   * because the console does something different with each.
   *
   * `NOT_PAUSABLE` and `NOT_PAUSED` mean the screen is out of date: re-read the
   * binding and the right button appears. `NEVER_PUBLISHED` means the provider
   * has to publish first, which is a different button on a different screen. A
   * single "wrong state" code would leave the console guessing which of the
   * three it is holding, from prose.
   */
  PROVIDER_BINDING_NOT_PAUSABLE = 'PROVIDER_BINDING_NOT_PAUSABLE',
  /** `POST …/resume` on a binding that is not `PAUSED`. */
  PROVIDER_BINDING_NOT_PAUSED = 'PROVIDER_BINDING_NOT_PAUSED',
  /**
   * `POST …/resume` on a binding with no live revision.
   *
   * `chk_tool_bindings_active_is_published` forbids `ACTIVE` on a row whose
   * `published_version` is null, so this refusal is what stops the resume path
   * from handing Postgres a statement it will reject with something no
   * provider can act on.
   */
  PROVIDER_BINDING_NEVER_PUBLISHED = 'PROVIDER_BINDING_NEVER_PUBLISHED',
  /**
   * `POST`/`PATCH …/tool-bindings` named a chain the provider has no enrolment
   * on. 409 — see the factory entry.
   */
  PROVIDER_BINDING_CHAIN_NOT_ENROLLED = 'PROVIDER_BINDING_CHAIN_NOT_ENROLLED',
  /** Enrolled on the chain, and the collateral behind it is not there. 409. */
  PROVIDER_BINDING_CHAIN_STAKE_BELOW_MINIMUM = 'PROVIDER_BINDING_CHAIN_STAKE_BELOW_MINIMUM',
  /** A chain this deployment does not offer at all. 400. */
  PROVIDER_BINDING_CHAIN_NOT_ENABLED = 'PROVIDER_BINDING_CHAIN_NOT_ENABLED',
  /** A non-FREE binding priced at zero. 400. */
  PROVIDER_BINDING_PRICE_NOT_POSITIVE = 'PROVIDER_BINDING_PRICE_NOT_POSITIVE',
  /** `GET /providers/me/sla-windows/:windowId/evidence` — `windowId` does not decode to a window. */
  PROVIDER_SLA_WINDOW_NOT_FOUND = 'PROVIDER_SLA_WINDOW_NOT_FOUND',
  /** `from` is not strictly before `to` on a report endpoint (traffic, quality, earnings). */
  PROVIDER_INVALID_TIME_RANGE = 'PROVIDER_INVALID_TIME_RANGE',
  /** A report window spans more than one asset with no `?asset=` filter to disambiguate. */
  PROVIDER_MULTIPLE_ASSETS = 'PROVIDER_MULTIPLE_ASSETS',
  /** Stored credentials cannot be decrypted right now (key missing or ciphertext failed authentication). */
  PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE = 'PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE',
  /** No active vault key is configured, so credentials cannot be stored. */
  PROVIDER_CREDENTIAL_VAULT_NOT_CONFIGURED = 'PROVIDER_CREDENTIAL_VAULT_NOT_CONFIGURED',
  /** A credential-like key sits in the endpoint query or a constant mapping query entry. */
  PROVIDER_CREDENTIAL_IN_QUERY = 'PROVIDER_CREDENTIAL_IN_QUERY',
  /** A secret-looking header is set to a constant in a request mapping. */
  PROVIDER_SECRET_IN_MAPPING = 'PROVIDER_SECRET_IN_MAPPING',
  /** A request mapping sets a header in the platform's `x-assay-` namespace. */
  PROVIDER_RESERVED_MAPPING_HEADER = 'PROVIDER_RESERVED_MAPPING_HEADER',
  /** A credential header set breaks the name, value or size rules. */
  PROVIDER_INVALID_CREDENTIAL_HEADERS = 'PROVIDER_INVALID_CREDENTIAL_HEADERS',
  /** A credential set names an origin the binding does not use (draft or published endpoint). */
  PROVIDER_CREDENTIAL_ORIGIN_MISMATCH = 'PROVIDER_CREDENTIAL_ORIGIN_MISMATCH',
  /** The credential set for the live (published, ACTIVE) origin cannot be deleted. 409. */
  PROVIDER_CREDENTIAL_ORIGIN_LIVE = 'PROVIDER_CREDENTIAL_ORIGIN_LIVE',
  /** The endpoint names a port the egress relay cannot reach. */
  PROVIDER_ENDPOINT_PORT_NOT_SUPPORTED = 'PROVIDER_ENDPOINT_PORT_NOT_SUPPORTED',
}

export type ProviderErrorCodesArePrefixed = AssertDomainErrorCodes<
  'PROVIDER',
  `${ProviderErrorCode}`
>;

/**
 * The half of `PROVIDER_STAKE_AUTHORITY_STILL_FUNDED` that does not depend on
 * which balance is blocking the rotation: *why* the platform refuses at all.
 *
 * Held in one place because the message branches and the explanation does not —
 * two copies of one rule are two chances for them to drift into disagreeing
 * about it.
 */
const STAKE_AUTHORITY_IMMOVABLE_WHILE_SLASHABLE =
  ' The authority cannot move while the account it names is still slashable, because a slash' +
  ' would follow the new key to an empty account and leave the collateral behind.';

export const ProviderErrors = createDomainErrorFactory('PROVIDER', {
  providerNotFound: {
    code: ProviderErrorCode.PROVIDER_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Provider not found${context?.providerId ? `: ${context.providerId}` : ''}`,
  },
  alreadyRegistered: {
    code: ProviderErrorCode.PROVIDER_ALREADY_REGISTERED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Provider already registered${context?.legalName ? `: ${context.legalName}` : ''}`,
  },
  providerSuspended: {
    code: ProviderErrorCode.PROVIDER_SUSPENDED,
    statusCode: 403,
    message: (context?: Record<string, any>) =>
      `Provider is suspended${context?.providerId ? `: ${context.providerId}` : ''}` +
      `${context?.reason ? ` (${context.reason})` : ''}`,
  },
  payoutAddressUnproven: {
    code: ProviderErrorCode.PROVIDER_PAYOUT_ADDRESS_UNPROVEN,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Payout address has not been proven by wallet signature` +
      `${context?.accountId ? `: ${context.accountId}` : ''}`,
  },
  connectivityCheckFailed: {
    code: ProviderErrorCode.PROVIDER_CONNECTIVITY_CHECK_FAILED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Endpoint failed the connectivity check` +
      `${context?.endpoint ? `: ${context.endpoint}` : ''}` +
      `${context?.detail ? ` (${context.detail})` : ''}`,
  },
  egressRateLimited: {
    code: ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    statusCode: 429,
    message: (context?: Record<string, any>) =>
      `Too many outbound test calls${context?.reason ? ` (${context.reason})` : ''}; try again shortly`,
  },
  payoutChallengeNotFound: {
    code: ProviderErrorCode.PROVIDER_PAYOUT_CHALLENGE_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No open payout challenge${context?.challengeId ? ` with id: ${context.challengeId}` : ''}`,
  },
  payoutChallengeExpired: {
    code: ProviderErrorCode.PROVIDER_PAYOUT_CHALLENGE_EXPIRED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Payout challenge expired${context?.expiresAt ? ` at ${context.expiresAt}` : ''}` +
      ` — request a new one`,
  },
  payoutChallengeAlreadyUsed: {
    code: ProviderErrorCode.PROVIDER_PAYOUT_CHALLENGE_ALREADY_USED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Payout challenge has already been used` +
      `${context?.consumedAt ? ` at ${context.consumedAt}` : ''}`,
  },
  payoutSignatureInvalid: {
    code: ProviderErrorCode.PROVIDER_PAYOUT_SIGNATURE_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Signature does not verify against the challenged address` +
      `${context?.accountId ? `: ${context.accountId}` : ''}`,
  },
  endpointPortNotRelayable: {
    code: ProviderErrorCode.PROVIDER_ENDPOINT_PORT_NOT_SUPPORTED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Port ${context?.port} is not supported. Use 443 or one of: ` +
      `${RELAY_ALLOWED_PORTS.filter((port) => port !== 443).join(', ')}.`,
  },
  endpointNotDeclared: {
    code: ProviderErrorCode.PROVIDER_ENDPOINT_NOT_DECLARED,
    statusCode: 400,
    message: () => `No endpoint has been declared — send one with the check, or save one first`,
  },
  contactsNotDistinct: {
    code: ProviderErrorCode.PROVIDER_CONTACTS_NOT_DISTINCT,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `The technical and owner contacts must be different people` +
      `${context?.email ? ` — both are ${context.email}` : ''}`,
  },
  timezoneUnknown: {
    code: ProviderErrorCode.PROVIDER_TIMEZONE_UNKNOWN,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Not an IANA time zone${context?.timezone ? `: ${context.timezone}` : ''}`,
  },
  termsVersionMismatch: {
    code: ProviderErrorCode.PROVIDER_TERMS_VERSION_MISMATCH,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Accepted terms are not the currently published versions` +
      `${context?.expected ? ` (expected ${context.expected}, got ${context.got})` : ''}`,
  },
  stakeNotFound: {
    code: ProviderErrorCode.PROVIDER_STAKE_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No stake account for provider${context?.providerId ? `: ${context.providerId}` : ''}`,
  },
  stakeBelowMinimum: {
    code: ProviderErrorCode.PROVIDER_STAKE_BELOW_MINIMUM,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Stake is below the minimum` +
      `${context?.staked ? `: staked ${context.staked}, minimum ${context.minimum}` : ''}`,
  },
  stakeChallengeNotFound: {
    code: ProviderErrorCode.PROVIDER_STAKE_CHALLENGE_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No open stake-authority challenge` +
      `${context?.challengeId ? ` with id: ${context.challengeId}` : ''}`,
  },
  stakeChallengeExpired: {
    code: ProviderErrorCode.PROVIDER_STAKE_CHALLENGE_EXPIRED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Stake-authority challenge expired${context?.expiresAt ? ` at ${context.expiresAt}` : ''}` +
      ` — request a new one`,
  },
  stakeChallengeAlreadyUsed: {
    code: ProviderErrorCode.PROVIDER_STAKE_CHALLENGE_ALREADY_USED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Stake-authority challenge has already been used` +
      `${context?.consumedAt ? ` at ${context.consumedAt}` : ''}`,
  },
  stakeSignatureInvalid: {
    code: ProviderErrorCode.PROVIDER_STAKE_SIGNATURE_INVALID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Signature does not verify against the challenged stake authority` +
      `${context?.accountId ? `: ${context.accountId}` : ''}`,
  },
  stakeAuthorityAlreadyClaimed: {
    code: ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_ALREADY_CLAIMED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `That stake account is already proved by another provider` +
      `${context?.accountId ? `: ${context.accountId}` : ''}`,
  },
  /**
   * Deliberately verbose. A provider reads this while confused about why a key
   * change was rejected, and a bare "conflict" sends them to support — so the
   * message carries the balance that is blocking them, the account it is in,
   * and the sequence that clears it.
   */
  stakeAuthorityStillFunded: {
    code: ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_STILL_FUNDED,
    statusCode: 409,
    message: (context?: Record<string, any>) => {
      const account = context?.currentAuthority ? ` (${context.currentAuthority})` : '';

      return (
        `Your current stake account${account} still holds funds` +
        `${
          context?.remaining
            ? `: ${context.remaining} remaining — bonded ${context.bonded},` +
              ` unbonding ${context.unbonding}`
            : ''
        }` +
        `. Unstake it in full, wait out the unbonding period and withdraw;` +
        ` then prove the new stake authority.` +
        STAKE_AUTHORITY_IMMOVABLE_WHILE_SLASHABLE
      );
    },
  },
  /**
   * The fail-closed half of the gate above, given a status a provider can act
   * on.
   *
   * `503`, because nothing about the request is wrong: the platform simply
   * cannot prove right now that the old account is empty, and it refuses rather
   * than assume. What this replaces is a bare `500 Internal server error` — an
   * RPC failure inside the reader is not an `AppError`, so that is all the
   * filter had to say — which is a refusal with no remedy attached.
   *
   * The cause is carried into the message on purpose. Most of the time it is
   * transient and "retry" is the whole answer, but there is one deployment
   * where it is not: `SETTLEMENT_PROGRAM_ID` is legitimately unset on a
   * deployment with no settlement program, and there every provider who has
   * proved once can never prove again. That failure is indistinguishable from a
   * flaky RPC unless the message says which one it was.
   */
  stakeAuthorityCheckUnavailable: {
    code: ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_CHECK_UNAVAILABLE,
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `Your current stake account could not be read, so the stake authority was not changed` +
      `${context?.currentAuthority ? ` (${context.currentAuthority})` : ''}` +
      `${context?.reason ? `: ${context.reason}` : ''}` +
      `. This check fails closed on purpose — an account that cannot be read is never treated` +
      ` as an empty one. Nothing was consumed, so retry with the same challenge while it is` +
      ` still valid; if it keeps failing, the settlement RPC or its configuration needs` +
      ` attention.`,
  },
  stakeAuthorityUnproven: {
    code: ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_UNPROVEN,
    statusCode: 409,
    message: (_context?: Record<string, any>) =>
      `You have not proved a stake authority yet, so there is no account to stake into.` +
      ` Sign the challenge at POST /providers/me/stake-authority/challenge first — the platform` +
      ` derives your stake account from the wallet that signs it, and will never take that` +
      ` address from a request body.`,
  },
  /**
   * The same fact as {@link stakeAuthorityUnproven}, told to somebody who is
   * not the provider: an operator route that has to build a transaction
   * against the provider's stake account and finds no account to name.
   *
   * It used to be reported as `SLASH_NOT_EXECUTED` — "Nothing to compensate:
   * this proposal never executed" — on a cancel and on an executed case alike.
   */
  stakeAuthorityUnprovenFor: {
    code: ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_UNPROVEN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Provider ${String(context?.providerId ?? '')} has no proved stake authority on ` +
      `${String(context?.chainId ?? 'that chain')}, so there is no stake account to name and ` +
      `no transaction can be built. Nothing was signed or submitted.`,
  },
  chainNotEnrolled: {
    code: ProviderErrorCode.PROVIDER_CHAIN_NOT_ENROLLED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `You have not enrolled on ${String(context?.chainId ?? 'that chain')}, so there is no` +
      ` enrolment to record a stake authority against. Prove a payout address on that chain` +
      ` first (POST /providers/me/payout-address/challenge) — staking on a chain with no payout` +
      ` address would put collateral behind calls whose earnings have nowhere to go.`,
  },
  stakeAuthorityAmbiguous: {
    code: ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_AMBIGUOUS,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `You have proved a stake authority on more than one chain` +
      `${context?.chains ? ` (${context.chains})` : ''}` +
      `, and this endpoint has no field naming which one to act on. It refuses rather than` +
      ` picking: the transaction it would return is signed against one chain's stake account,` +
      ` and the wrong one would be a transaction you did not mean to sign.`,
  },
  minimumStakeUnconfigured: {
    code: ProviderErrorCode.PROVIDER_MINIMUM_STAKE_UNCONFIGURED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `No minimum stake floor is configured for ${String(context?.chains ?? 'an enabled chain')}.` +
      ` Every chain in ENABLED_CHAINS needs one — the full minimum on each, because collateral` +
      ` on one chain is invisible to the settlement contract of another.` +
      ` ${String(context?.variable ?? 'PLATFORM_STAKE_ASSET_ID')} and PROVIDER_MINIMUM_STAKE_FLOOR` +
      ` name ONE asset between them, so no value of them satisfies this for more than one chain:` +
      ` setting them to another chain's asset only moves the failure. Either run with a single` +
      ` chain in ENABLED_CHAINS, or add the per-chain floor configuration this refusal exists to` +
      ` demand (loadMinimumStakeParameters in provider-stake.service.ts is the seam; it also` +
      ` hardcodes decimals: 6, which an 18-decimal collateral asset would need).`,
  },
  stakeAccountAlreadyOpen: {
    code: ProviderErrorCode.PROVIDER_STAKE_ACCOUNT_ALREADY_OPEN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Your stake account is already open` +
      `${context?.account ? ` (${context.account})` : ''}` +
      `. Deposit into it instead — opening it again is refused on chain as well, because an` +
      ` initializer that can run on an existing account is the shape reinitialisation attacks` +
      ` are made of.`,
  },
  stakeAccountNotOpen: {
    code: ProviderErrorCode.PROVIDER_STAKE_ACCOUNT_NOT_OPEN,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `You have no stake account yet` +
      `${context?.account ? ` at the authority ${context.account}` : ''}` +
      `, so a ${String(context?.kind ?? 'stake')} intent has nothing to act on.` +
      ` Run POST /providers/me/stake/open-stake-intent and sign it first; you pay rent for that` +
      ` account, and the preflight says how much.`,
  },
  stakeAccountNotNeeded: {
    code: ProviderErrorCode.PROVIDER_STAKE_ACCOUNT_NOT_NEEDED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `There is no stake account to open` +
      `${context?.account ? ` for ${context.account}` : ''}` +
      ` on this chain: the stake contract keys your stake on your address, and your first` +
      ` deposit creates it. Deposit instead.`,
  },
  stakeChainUnavailable: {
    code: ProviderErrorCode.PROVIDER_STAKE_CHAIN_UNAVAILABLE,
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `Your stake account could not be read, so no transaction was built` +
      `${context?.reason ? `: ${context.reason}` : ''}` +
      `. This fails closed on purpose — a preflight built without the chain would quote balances` +
      ` nobody verified, and a transaction built without reading the stake mint would move a` +
      ` token you did not choose. Nothing was signed or submitted; retry.`,
  },
  publishChecksFailed: {
    code: ProviderErrorCode.PROVIDER_PUBLISH_CHECKS_FAILED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Binding cannot be published until every check passes` +
      `${context?.failed ? `: ${context.failed}` : ''}`,
  },
  bindingNotFound: {
    code: ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No binding of yours with id${context?.bindingId ? `: ${context.bindingId}` : ' (unknown)'}`,
  },
  bindingAlreadyExists: {
    code: ProviderErrorCode.PROVIDER_BINDING_ALREADY_EXISTS,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `You already have a binding for this tool` +
      `${context?.toolId ? `: ${context.toolId}` : ''}. Edit that one, or suspend it first.`,
  },
  bindingContractMismatch: {
    code: ProviderErrorCode.PROVIDER_BINDING_CONTRACT_MISMATCH,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `This binding does not fit the tool's contract` +
      `${Array.isArray(context?.problems) && context.problems.length > 0 ? `: ${context.problems.join('; ')}` : ''}`,
    publicContext: ['problems'],
  },
  bindingToolUnknown: {
    code: ProviderErrorCode.PROVIDER_BINDING_TOOL_UNKNOWN,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No tool in the catalogue with id${context?.toolId ? `: ${context.toolId}` : ' (unknown)'}`,
  },
  bindingNotEditable: {
    code: ProviderErrorCode.PROVIDER_BINDING_NOT_EDITABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This binding is ${context?.status ?? 'not editable'} and cannot be changed here`,
  },
  bindingAlreadyPublished: {
    code: ProviderErrorCode.PROVIDER_BINDING_ALREADY_PUBLISHED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Revision ${context?.mappingVersion ?? ''} is already live. Save a change before publishing again.`,
  },
  bindingNotPausable: {
    code: ProviderErrorCode.PROVIDER_BINDING_NOT_PAUSABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Only a serving binding can be paused; this one is ${context?.status ?? 'not ACTIVE'}`,
  },
  bindingNotPaused: {
    code: ProviderErrorCode.PROVIDER_BINDING_NOT_PAUSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This binding is ${context?.status ?? 'not paused'}, so there is nothing to resume`,
  },
  bindingNeverPublished: {
    code: ProviderErrorCode.PROVIDER_BINDING_NEVER_PUBLISHED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Binding ${context?.bindingId ?? '(unknown)'} has never been published. ` +
      `Publish it rather than resuming it.`,
  },
  /**
   * A binding named a chain its provider has no enrolment on.
   *
   * 409, not 400: the request is well-formed and the provider can make it valid
   * by enrolling. A 400 would read as "you sent nonsense".
   */
  bindingChainNotEnrolled: {
    code: ProviderErrorCode.PROVIDER_BINDING_CHAIN_NOT_ENROLLED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This binding cannot be offered on ${context?.chainId ?? '?'}: you have no chain ` +
      `enrolment there. Prove a payout address on that chain first.`,
  },

  /**
   * Enrolled, but the collateral is not there.
   *
   * Deliberately distinct from `bindingChainNotEnrolled`: the two are fixed by
   * different actions — one is a signature, the other is a transfer — and
   * collapsing them would send a provider to the wrong screen. Same reasoning
   * `IneligibilityReason` gives for keeping `STAKE_UNKNOWN`,
   * `STAKE_BELOW_MINIMUM` and `PAYOUT_ACCOUNT_UNPROVED` apart.
   */
  bindingChainStakeBelowMinimum: {
    code: ProviderErrorCode.PROVIDER_BINDING_CHAIN_STAKE_BELOW_MINIMUM,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This binding cannot be offered on ${context?.chainId ?? '?'}: ` +
      `${context?.detail ?? 'stake is below the minimum for that chain'}. ` +
      `Collateral is per chain and is not shared — a stake on another chain cannot be ` +
      `slashed by this one.`,
  },

  /**
   * A chain this deployment does not offer at all.
   *
   * 400 here, unlike the two above: nothing the provider can do makes it valid,
   * because it is not a fact about them.
   */
  bindingChainNotEnabled: {
    code: ProviderErrorCode.PROVIDER_BINDING_CHAIN_NOT_ENABLED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `${context?.chainId ?? '?'} is not offered by this deployment. ` +
      `Available: ${context?.enabled ?? '(none)'}.`,
  },

  /**
   * `PAID`, or the paid tier of a `FREEMIUM`, at a price of zero.
   *
   * A zero price on a mode that charges is a binding that settles nothing while
   * looking paid; `FREE` is the honest spelling of that.
   */
  bindingPriceNotPositive: {
    code: ProviderErrorCode.PROVIDER_BINDING_PRICE_NOT_POSITIVE,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `A ${context?.pricingMode ?? 'priced'} binding needs a price above zero. ` +
      `Use pricingMode FREE for a binding that costs nothing.`,
  },

  slaWindowNotFound: {
    code: ProviderErrorCode.PROVIDER_SLA_WINDOW_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No SLA window${context?.windowId ? `: ${context.windowId}` : ''}`,
  },
  invalidTimeRange: {
    code: ProviderErrorCode.PROVIDER_INVALID_TIME_RANGE,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `\`from\` (${context?.from}) must be earlier than \`to\` (${context?.to})`,
  },
  multipleAssets: {
    code: ProviderErrorCode.PROVIDER_MULTIPLE_ASSETS,
    statusCode: 422,
    message: (context?: Record<string, any>) =>
      `The requested window spans more than one asset (${context?.assets ?? '?'})` +
      ` — pass ?asset= to pick one`,
  },
  credentialVaultUnavailable: {
    code: ProviderErrorCode.PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE,
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `Stored provider credentials could not be decrypted` +
      `${context?.reason ? ` (${context.reason})` : ''}` +
      `. The call was not sent.`,
  },
  credentialVaultNotConfigured: {
    code: ProviderErrorCode.PROVIDER_CREDENTIAL_VAULT_NOT_CONFIGURED,
    statusCode: 503,
    message: () => `Credential storage is not configured on this deployment (no active vault key)`,
  },
  credentialInQuery: {
    code: ProviderErrorCode.PROVIDER_CREDENTIAL_IN_QUERY,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Credential-like query parameter${(context?.keys?.length ?? 0) === 1 ? '' : 's'}: ` +
      `${(context?.keys ?? []).join(', ')}. ` +
      `URLs are logged by proxies, CDNs and servers and leak through browser history and ` +
      `Referer headers. Send the key as a header: Authentication → API key.`,
  },
  secretInMapping: {
    code: ProviderErrorCode.PROVIDER_SECRET_IN_MAPPING,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `${context?.headers?.length ? `Header ${context.headers.join(', ')}: ` : ''}` +
      `Move this header to Authentication → API key; mappings are stored in plain text.`,
  },
  reservedMappingHeader: {
    code: ProviderErrorCode.PROVIDER_RESERVED_MAPPING_HEADER,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Header ${(context?.headers ?? []).join(', ')}: names starting with x-assay- are set by ` +
      `Assay itself. Rename or remove the header.`,
  },
  invalidCredentialHeaders: {
    code: ProviderErrorCode.PROVIDER_INVALID_CREDENTIAL_HEADERS,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Invalid credential headers: ${(context?.problems ?? []).join('; ')}`,
  },
  credentialOriginLive: {
    code: ProviderErrorCode.PROVIDER_CREDENTIAL_ORIGIN_LIVE,
    statusCode: 409,
    message: () =>
      `These credentials belong to the live endpoint of an active binding. Pause the binding ` +
      `or publish a revision with a different endpoint before removing them; replace them ` +
      `instead to rotate the key.`,
  },
  credentialOriginMismatch: {
    code: ProviderErrorCode.PROVIDER_CREDENTIAL_ORIGIN_MISMATCH,
    statusCode: 400,
    message: () =>
      `Credentials can only be stored for the origin of this binding's endpoint (draft or published).`,
  },
});
