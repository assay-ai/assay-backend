/**
 * The dispute upgrade's unsigned transactions (assay-evm D-19), built here and
 * signed by a PERSON: the provider disputes, the arbiter rules and blocks.
 *
 * ## Why every builder reads every record first
 *
 * `disputeSlashBatch`, `upholdSlashBatch` and `cancelSlashBatch` are atomic,
 * like `redeemVoucherBatch`: one bad or duplicate id reverts the whole batch.
 * So each id is checked with `slashRecordOf` against the rule the contract
 * will apply, and a batch is only handed out when every id passes. The
 * contract stays the enforcer; this only spares a person a transaction that
 * cannot land, and tells them which id is wrong and why.
 *
 * ## The backend never signs any of these
 *
 * No key this process holds can call these doors: `disputeSlash` is the
 * record's provider's, `upholdSlash` and `setBlocked(…, true)` the arbiter's,
 * `cancelSlash` the arbiter's (the admin's too on chain, but the backend
 * builds it for the arbiter only). A built intent changes nothing;
 * the chain watcher sees the result when the person's transaction lands.
 */
import { ChainId } from '@modules/chains/ports/caip.types';

/** What the Config says about the dispute upgrade on one chain, read live. */
export interface SlashChainTerms {
  readonly chainId: ChainId;
  readonly paused: boolean;
  /** `X402Config.arbiter()`, checksummed, or `null` for none. */
  readonly arbiter: string | null;
  /** `X402Config.admin()`, checksummed. */
  readonly admin: string;
  /** The delay a proposal made now would freeze into its `executableAt`. */
  readonly slashDelaySeconds: number;
}

/** Who must sign a built call. */
export type SlashCallSigner = 'PROVIDER' | 'ARBITER';

/** One unsigned contract call: `to` + `data`, sent by `signer` with no value. */
export interface SlashContractCall {
  readonly chainId: ChainId;
  /** The contract (proxy) the call is addressed to. */
  readonly to: string;
  /** ABI-encoded calldata, `0x`-hex. */
  readonly data: string;
  /** Always `'0'`: none of these doors takes value. */
  readonly value: '0';
  /** The only account the contract accepts the call from, checksummed. */
  readonly signer: string;
  readonly signerRole: SlashCallSigner;
  /** The Solidity function the calldata invokes, for the wallet's review screen. */
  readonly functionName: string;
  /** The request ids the call carries, in calldata order. Empty for `setBlocked`. */
  readonly requestIds: readonly string[];
}

/**
 * Why one id cannot go into the batch — the contract's own error name where
 * there is one, so a person reads the refusal the chain would have given.
 */
export interface SlashIdRefusal {
  readonly requestId: string;
  readonly reason:
    | 'NoSuchRecord'
    | 'DuplicateId'
    | 'NotSlashedProvider'
    | 'SlashNotPending'
    | 'DisputeWindowClosed'
    | 'SlashNotDisputed'
    | 'ArbiterIsVerifier'
    | 'DisputeTimedOut';
  readonly detail: string;
}

/** A batch the chain would accept, or the reasons it would not. Never both. */
export type SlashBatchBuild =
  | { readonly call: SlashContractCall; readonly refusals: readonly [] }
  | { readonly call: null; readonly refusals: readonly SlashIdRefusal[] };

export type SlashRuling = 'UPHOLD' | 'CANCEL';

export interface SlashDisputeIntentPort {
  chainTerms(chainId: ChainId): Promise<SlashChainTerms>;

  /** `disputeSlashBatch(ids)` for `provider` (the stake authority's address). */
  buildDisputeBatch(request: {
    readonly chainId: ChainId;
    readonly provider: string;
    readonly requestIds: readonly string[];
  }): Promise<SlashBatchBuild>;

  /**
   * `upholdSlashBatch(ids)` or `cancelSlashBatch(ids)`, both for the arbiter
   * (`CHAIN_ARBITER_NOT_SET` when none is appointed).
   */
  buildRulingBatch(request: {
    readonly chainId: ChainId;
    readonly ruling: SlashRuling;
    readonly requestIds: readonly string[];
  }): Promise<SlashBatchBuild>;

  /** `setBlocked(account, true)`, for the arbiter. Block only: unblocking is the admin's. */
  buildBlock(request: {
    readonly chainId: ChainId;
    readonly account: string;
  }): Promise<SlashContractCall>;
}

export const SLASH_DISPUTE_INTENTS = 'SLASH_DISPUTE_INTENTS';
