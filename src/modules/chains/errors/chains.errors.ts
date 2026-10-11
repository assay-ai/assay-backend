import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `CHAIN_*` — the boundary between the domain and any blockchain.
 *
 * Every one of these fires *at* the boundary. A domain service never sees a
 * base58 string, a mint address or an RPC response, so it can never raise one
 * of these itself — which is the point.
 */
export enum ChainErrorCode {
  CHAIN_INVALID_CHAIN_ID = 'CHAIN_INVALID_CHAIN_ID',
  CHAIN_INVALID_ACCOUNT_ID = 'CHAIN_INVALID_ACCOUNT_ID',
  CHAIN_INVALID_ASSET_ID = 'CHAIN_INVALID_ASSET_ID',
  CHAIN_INVALID_ADDRESS = 'CHAIN_INVALID_ADDRESS',
  CHAIN_NAMESPACE_MISMATCH = 'CHAIN_NAMESPACE_MISMATCH',
  CHAIN_UNSUPPORTED = 'CHAIN_UNSUPPORTED',
  CHAIN_ADAPTER_DUPLICATE_NAMESPACE = 'CHAIN_ADAPTER_DUPLICATE_NAMESPACE',
  CHAIN_ASSET_UNKNOWN = 'CHAIN_ASSET_UNKNOWN',
  CHAIN_ASSET_NOT_ON_CHAIN = 'CHAIN_ASSET_NOT_ON_CHAIN',
  CHAIN_ASSET_DECIMALS_MISMATCH = 'CHAIN_ASSET_DECIMALS_MISMATCH',
  CHAIN_PAYLOAD_MALFORMED = 'CHAIN_PAYLOAD_MALFORMED',
  CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT = 'CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT',
  CHAIN_SETTLED_ASSET_MISMATCH = 'CHAIN_SETTLED_ASSET_MISMATCH',
  CHAIN_SETTLED_NETWORK_MISMATCH = 'CHAIN_SETTLED_NETWORK_MISMATCH',
  CHAIN_SETTLED_AMOUNT_BELOW_INTENT = 'CHAIN_SETTLED_AMOUNT_BELOW_INTENT',
  CHAIN_FACILITATOR_UNAVAILABLE = 'CHAIN_FACILITATOR_UNAVAILABLE',
  CHAIN_VAULT_NOT_CONFIGURED = 'CHAIN_VAULT_NOT_CONFIGURED',
  CHAIN_VAULT_CONTROL_UNVERIFIED = 'CHAIN_VAULT_CONTROL_UNVERIFIED',
  CHAIN_DEVNET_OVERRIDE_FORBIDDEN = 'CHAIN_DEVNET_OVERRIDE_FORBIDDEN',
  CHAIN_ENABLED_CHAINS_INVALID = 'CHAIN_ENABLED_CHAINS_INVALID',
  CHAIN_ENABLED_CHAINS_LEGACY_VARIABLE_SET = 'CHAIN_ENABLED_CHAINS_LEGACY_VARIABLE_SET',
  CHAIN_PROGRAM_NOT_CONFIGURED = 'CHAIN_PROGRAM_NOT_CONFIGURED',
  CHAIN_ACCOUNT_LAYOUT_UNEXPECTED = 'CHAIN_ACCOUNT_LAYOUT_UNEXPECTED',
  CHAIN_RPC_REPLY_MALFORMED = 'CHAIN_RPC_REPLY_MALFORMED',
  CHAIN_TRANSACTION_FAILED = 'CHAIN_TRANSACTION_FAILED',
  CHAIN_SLASH_RECORD_NOT_FOUND = 'CHAIN_SLASH_RECORD_NOT_FOUND',
  CHAIN_REDEEMER_MISMATCH = 'CHAIN_REDEEMER_MISMATCH',
  CHAIN_RAIL_NOT_OFFERED = 'CHAIN_RAIL_NOT_OFFERED',
  CHAIN_CONFIG_VALUE_INVALID = 'CHAIN_CONFIG_VALUE_INVALID',
  CHAIN_LATEST_BLOCK_STALE = 'CHAIN_LATEST_BLOCK_STALE',
  CHAIN_VOUCHER_AUTHORITY_UNAVAILABLE = 'CHAIN_VOUCHER_AUTHORITY_UNAVAILABLE',
}

export type ChainErrorCodesArePrefixed = AssertDomainErrorCodes<'CHAIN', `${ChainErrorCode}`>;

export const ChainErrors = createDomainErrorFactory('CHAIN', {
  invalidChainId: {
    code: ChainErrorCode.CHAIN_INVALID_CHAIN_ID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Not a CAIP-2 chain id${context?.value !== undefined ? `: "${context.value}"` : ''}`,
  },
  invalidAccountId: {
    code: ChainErrorCode.CHAIN_INVALID_ACCOUNT_ID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Not a CAIP-10 account id${context?.value !== undefined ? `: "${context.value}"` : ''}`,
  },
  invalidAssetId: {
    code: ChainErrorCode.CHAIN_INVALID_ASSET_ID,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Not a CAIP-19 asset id${context?.value !== undefined ? `: "${context.value}"` : ''}`,
  },
  invalidAddress: {
    code: ChainErrorCode.CHAIN_INVALID_ADDRESS,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Address is not valid on this chain${context?.address ? `: "${context.address}"` : ''}` +
      `${context?.chainId ? ` (${context.chainId})` : ''}`,
  },
  namespaceMismatch: {
    code: ChainErrorCode.CHAIN_NAMESPACE_MISMATCH,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Adapter for "${context?.expected}" was handed "${context?.actual}"`,
  },
  unsupportedChain: {
    code: ChainErrorCode.CHAIN_UNSUPPORTED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `No chain adapter is enabled for${context?.chainId ? ` ${context.chainId}` : ' this chain'}`,
  },
  duplicateAdapterNamespace: {
    code: ChainErrorCode.CHAIN_ADAPTER_DUPLICATE_NAMESPACE,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Two chain adapters claim namespace "${context?.namespace}"`,
  },
  assetUnknown: {
    code: ChainErrorCode.CHAIN_ASSET_UNKNOWN,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `No asset metadata registered for${context?.asset ? ` ${context.asset}` : ' this asset'}`,
  },
  assetNotOnChain: {
    code: ChainErrorCode.CHAIN_ASSET_NOT_ON_CHAIN,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Asset ${context?.asset} does not live on ${context?.chainId}`,
  },
  assetDecimalsMismatch: {
    code: ChainErrorCode.CHAIN_ASSET_DECIMALS_MISMATCH,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Asset ${context?.asset} is registered with ${context?.expected} decimals but the chain ` +
      `reports ${context?.actual}`,
  },
  payloadMalformed: {
    code: ChainErrorCode.CHAIN_PAYLOAD_MALFORMED,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Payment payload could not be decoded${context?.reason ? `: ${context.reason}` : ''}`,
  },
  payloadNotBoundToIntent: {
    code: ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Payment payload is not bound to intent ${context?.intentId}` +
      `${context?.reason ? ` (${context.reason})` : ''}`,
  },
  settledAssetMismatch: {
    code: ChainErrorCode.CHAIN_SETTLED_ASSET_MISMATCH,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Settlement was in ${context?.actual} but intent ${context?.intentId} is in ${context?.expected}`,
  },
  /**
   * A receipt from one chain presented against an intent on another.
   *
   * 409, beside the other two settlement refusals: the request was well formed
   * and the chain disagreed with it. The asset comparison below cannot stand in
   * for this — two chains may both register an asset whose CAIP-19 reference is
   * the same string (the same ERC-20 address is deployable on every EVM chain,
   * and the same buyer holds it), so the assets compare equal while the money
   * moved somewhere else entirely.
   */
  settledNetworkMismatch: {
    code: ChainErrorCode.CHAIN_SETTLED_NETWORK_MISMATCH,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Settlement landed on ${context?.actual} but intent ${context?.intentId} is on ` +
      `${context?.expected}`,
  },
  settledAmountBelowIntent: {
    code: ChainErrorCode.CHAIN_SETTLED_AMOUNT_BELOW_INTENT,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Settlement of ${context?.actual} is below the ${context?.expected} required by intent ` +
      `${context?.intentId}`,
  },
  facilitatorUnavailable: {
    code: ChainErrorCode.CHAIN_FACILITATOR_UNAVAILABLE,
    statusCode: 502,
    message: (context?: Record<string, any>) =>
      `Facilitator could not be reached for ${context?.chainId}` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /** No `create_key` is configured — there is no multisig to derive a vault from. */
  vaultNotConfigured: {
    code: ChainErrorCode.CHAIN_VAULT_NOT_CONFIGURED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Treasury vault is not configured${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * The on-chain arrangement the vault depends on could not be proven: the
   * vault ATA's authority is not the derived vault PDA, or the derived
   * multisig PDA is not owned by the Squads program. A vault whose control
   * cannot be proven must fail loudly at the point of use rather than be
   * assumed correct.
   */
  vaultControlUnverified: {
    code: ChainErrorCode.CHAIN_VAULT_CONTROL_UNVERIFIED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Treasury vault control could not be verified on-chain` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /** A devnet-only env override was read outside devnet. Mainnet must never be overridable. */
  /**
   * `ENABLED_CHAINS` is unset, blank, or names something that is not a chain
   * this deployment can serve. Thrown at boot, because the alternative —
   * dropping the unreadable name, or defaulting — silently decides which chains
   * the deployment serves, and that decision is worth real money.
   */
  enabledChainsInvalid: {
    code: ChainErrorCode.CHAIN_ENABLED_CHAINS_INVALID,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `${context?.variable ?? 'Enabled chains'} names an unknown network` +
      `${context?.value !== undefined ? `: "${context.value}"` : ''}` +
      `${context?.accepted ? `. Accepted: ${context.accepted}` : ''}`,
  },
  /**
   * `SOLANA_ENABLED_CHAINS` is still set.
   *
   * A renamed variable that is silently ignored is how a deployment serves a
   * network the operator believes is off: they edited the old name, the process
   * read the new one, and nothing said so. Boot fails instead, naming the new
   * variable and printing the CAIP-2 translation of what the old one held so the
   * fix is a copy rather than a lookup.
   */
  enabledChainsLegacyVariableSet: {
    code: ChainErrorCode.CHAIN_ENABLED_CHAINS_LEGACY_VARIABLE_SET,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `${context?.legacy ?? 'SOLANA_ENABLED_CHAINS'} is set and is no longer read. ` +
      `Move it to ${context?.variable ?? 'ENABLED_CHAINS'} as CAIP-2 ids` +
      `${context?.translation ? `, e.g. ${context.translation}` : ''}, then unset it.`,
  },
  devnetOverrideForbidden: {
    code: ChainErrorCode.CHAIN_DEVNET_OVERRIDE_FORBIDDEN,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Devnet-only override is not permitted here${context?.variable ? ` (${context.variable})` : ''}` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * An on-chain program this deployment needs an address for has none.
   *
   * Raised at the call, not at boot — same reasoning as `vaultNotConfigured`
   * next door. A deployment that never reaches the settlement program (most
   * integration tests, and every process that only serves HTTP) has no business
   * failing to start because a program id it will not use is unset.
   */
  /**
   * `Config.redeemer` on the deployed program is not the key this process pays
   * redemptions with.
   *
   * Redemption stopped being permissionless: `redeem_voucher.rent_payer` now
   * carries `address = config.redeemer`, so a deployment whose configured
   * redeemer is anyone else refuses **every** redemption with `NotRedeemer`
   * (6053) — one wasted preflight per hold per pass, for ever, with nothing in
   * the logs naming the cause. This is that cause, said once and by name.
   *
   * It is a deployment fault, never a redemption failure: the fix is an admin
   * `update_config`, or pointing this process at the keypair the program was
   * initialised with. `500` for the same reason `programNotConfigured` is one.
   */
  redeemerMismatch: {
    code: ChainErrorCode.CHAIN_REDEEMER_MISMATCH,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `The settlement program's Config names ${context?.configured ?? 'another key'} as its ` +
      `redeemer, but this process pays redemptions with ` +
      `${context?.feePayer ?? 'a different key'} — every redeem_voucher would be refused ` +
      `NotRedeemer. Re-point FEE_PAYER_SIGNER at the configured redeemer, or move the ` +
      `redeemer with update_config.`,
  },
  programNotConfigured: {
    code: ChainErrorCode.CHAIN_PROGRAM_NOT_CONFIGURED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `No program id is configured for ${context?.what ?? 'a required program'}` +
      `${context?.variable ? ` — set ${context.variable}` : ''}`,
  },
  /**
   * An account decoded to something other than the layout this codebase expects.
   *
   * Always a deploy-skew bug: the program was upgraded and the decoder was not,
   * or the wrong program id is configured. It is a `500` and it is loud, because
   * the alternative — reading a field from the wrong offset — produces a number
   * that looks like data and is used to decide who may sign.
   */
  accountLayoutUnexpected: {
    code: ChainErrorCode.CHAIN_ACCOUNT_LAYOUT_UNEXPECTED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `On-chain account does not match the expected layout` +
      `${context?.account ? ` (${context.account})` : ''}` +
      `${context?.expected !== undefined ? ` — expected ${context.expected}` : ''}` +
      `${context?.actual !== undefined ? `, got ${context.actual}` : ''}`,
  },
  /**
   * A batched account read answered for a different number of addresses than it
   * was asked about.
   *
   * Not a layout problem and deliberately its own code: the bytes are fine, the
   * *shape of the reply* is not. It matters because a batched reply is zipped
   * back onto the request by **position**, so a short one does not read as an
   * error — it reads as "there is no account at those seeds", which is a
   * perfectly ordinary answer with a meaning of its own. One caller
   * (`ProviderStakeAuthorityService.prove`) turns that answer into "the
   * provider has fully exited, so they may re-point their stake authority", and
   * a truncated reply would hand a defecting provider exactly the rotation that
   * gate exists to refuse. Unreadable must never be able to substitute for
   * empty, so a reply that does not answer for what was asked is an error.
   *
   * `502` rather than `500`: the upstream node gave us a bad answer, and the
   * remedy is another node or another attempt, not a code change.
   */
  rpcReplyMalformed: {
    code: ChainErrorCode.CHAIN_RPC_REPLY_MALFORMED,
    statusCode: 502,
    message: (context?: Record<string, any>) =>
      `Chain RPC returned a malformed reply` +
      `${context?.method ? ` from ${context.method}` : ''}` +
      `${context?.expected !== undefined ? ` — asked about ${context.expected} accounts` : ''}` +
      `${context?.actual !== undefined ? `, answered for ${context.actual}` : ''}`,
  },
  /**
   * A transaction this codebase submitted was refused — in simulation, on
   * chain, or by never confirming at all.
   *
   * **The context is the point, not the message.** `customErrorCode` carries the
   * Anchor custom-program-error number, so a caller can resolve the *name* of
   * the refusal against the vendored IDL and decide what it means: a revoked
   * verifier key voids a judgement outright, an unelapsed timelock means wait,
   * an expired blockhash means retry. The rendered message cannot carry that —
   * `getX402PaymentErrorMessage` returns the human sentence, and a fixed
   * placeholder in production — so a caller that parsed the string would
   * collapse every one of those outcomes into "try again".
   *
   * `customErrorCode: null` means the program never spoke: an RPC failure, an
   * expired blockhash, a confirmation timeout. That is a genuinely different
   * class of event and is why the field is nullable rather than absent.
   *
   * `502` for the same reason `rpcReplyMalformed` is: the remedy is another
   * attempt or another node, not a code change — and it is never on the wire
   * anyway, since every caller is a background job.
   */
  transactionFailed: {
    code: ChainErrorCode.CHAIN_TRANSACTION_FAILED,
    statusCode: 502,
    message: (context?: Record<string, any>) =>
      `Chain refused the transaction` +
      `${context?.instruction ? ` (${context.instruction})` : ''}` +
      `${context?.signature ? ` ${context.signature}` : ''}` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * No `SlashRecord` exists at the PDA a request id derives — asked *before*
   * any transaction is built, by the phases that must read the record to build
   * one (`execute_slash`, `expire_slash`, `cancel_slash`, `reverse_slash`).
   *
   * **This is terminal, and that is the whole reason it is its own code.** A
   * `SlashRecord` is a PDA seeded on the request id: there is exactly one
   * address it can ever occupy, and `cancel_slash`/`expire_slash` close the
   * account when they release the reservation. So "absent" means either the
   * proposal never landed or the judgement is already finished — and in neither
   * case can any number of retries make it executable. A caller that treats
   * this as transient retries until the record's grace period reaps it.
   *
   * Deliberately **not** {@link ChainErrorCode.CHAIN_TRANSACTION_FAILED}: that
   * code means the chain refused a submission, and its `customErrorCode: null`
   * means "the program never spoke", which the classifier reads as transient.
   * Folding this into it would be exactly backwards. Deliberately not
   * {@link ChainErrorCode.CHAIN_ACCOUNT_LAYOUT_UNEXPECTED} either — that says a
   * deploy is skewed and a human should look; this says a judgement is over.
   */
  slashRecordNotFound: {
    code: ChainErrorCode.CHAIN_SLASH_RECORD_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `No slash record exists for this judgement` +
      `${context?.requestId ? ` (request ${context.requestId})` : ''}` +
      `${context?.account ? ` at ${context.account}` : ''}` +
      ` — it was never proposed, or it has already been cancelled or expired`,
  },
  /**
   * A payment rail was chosen for a chain whose `chain-metadata.ts` row does not
   * offer it.
   *
   * Supported rails are per-chain: Solana keeps A and B, 4663 ships B only. The
   * 402 response on 4663 never advertises a rail A scheme, and the router never
   * selects one. This error is the reader that makes `ChainMetadata.rails` more
   * than a declaration.
   *
   * **500, not 400.** No caller supplies a rail: the platform picks one from the
   * code path the request happened to arrive on, so a rail the chain does not
   * offer is our own wiring being wrong on a chain we enabled. A 4xx would blame
   * a buyer for it and would land in the status class nobody alerts on.
   *
   * `offered` is in the context because the operator fixing it wants the whole
   * row, not the one value that failed.
   */
  railNotOffered: {
    code: ChainErrorCode.CHAIN_RAIL_NOT_OFFERED,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `Chain ${context?.chainId} does not offer payment rail ${context?.rail}` +
      `${context?.offered ? ` — it offers [${(context.offered as string[]).join(', ')}]` : ''}`,
  },
  /**
   * A configuration value this module reads is missing or unusable.
   *
   * Its own code rather than {@link enabledChainsInvalid}, whose message reads
   * *"X names an unknown network"* — true of a chain list and a lie about a
   * number of wei. A boot error that misdescribes what it read sends an operator
   * to the wrong file, which is the failure this catalogue exists to prevent.
   *
   * The value is deliberately **not** interpolated. These particular variables
   * carry caps and URLs rather than keys; the habit is the point
   * (`docs/architecture.md` §"Signing Keys" rule 6), and this factory sits one
   * import away from every key-bearing parser in the module.
   */
  configValueInvalid: {
    code: ChainErrorCode.CHAIN_CONFIG_VALUE_INVALID,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      `${context?.variable ?? 'A configuration value'} is missing or unusable` +
      `${context?.accepted ? ` — expected ${context.accepted}` : ''}`,
  },
  /**
   * The chain's latest block is too old to stamp a signature deadline against.
   *
   * Every `*BySig` deadline is `latest.timestamp + VOUCHER_MAX_LIFETIME_SECONDS`
   * and the contract judges it against the block that *includes* the relayed
   * call, so the usable window is `300 − (age of the latest block)` and goes
   * NEGATIVE on a chain that has stopped producing blocks — 2,001 s of staleness
   * measured on the local fork, every request born 1,701 s expired. This is what refusing to issue
   * looks like instead; see `EvmEscrowIntentBuilder.deadline`.
   *
   * `503` and not `400`: nothing about the request is wrong, the remedy is to
   * ask again once the chain has moved, and a caller that retries is doing the
   * right thing. `500` would say this process is broken, and it is not.
   */
  latestBlockStale: {
    code: ChainErrorCode.CHAIN_LATEST_BLOCK_STALE,
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `The chain's latest block is too old to sign against` +
      `${context?.chainId ? ` on ${context.chainId}` : ''}` +
      `${context?.ageSeconds !== undefined ? ` — ${context.ageSeconds}s old` : ''}` +
      `${
        context?.usableWindowSeconds !== undefined
          ? `, leaving ${context.usableWindowSeconds}s of signature validity`
          : ''
      }` +
      `${context?.minimumSeconds !== undefined ? ` of a required ${context.minimumSeconds}s` : ''}`,
  },
  /**
   * The chain state a voucher's authority depends on (the payer's code, a
   * delegate's on-chain grant, a wallet's EIP-1271 answer) could not be read.
   *
   * **Fail closed**: the voucher is refused, not assumed good, because the only
   * thing standing between an unreadable delegation and a served call is this
   * read. `503` and retryable — the remedy is another attempt.
   */
  voucherAuthorityUnavailable: {
    code: ChainErrorCode.CHAIN_VOUCHER_AUTHORITY_UNAVAILABLE,
    statusCode: 503,
    message: (context?: Record<string, any>) =>
      `The chain state that decides who may sign this voucher could not be read` +
      `${context?.what ? ` (${context.what})` : ''}; nothing was charged — try again`,
  },
});
