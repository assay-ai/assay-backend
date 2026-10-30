import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  sha256,
  toBytes,
  toHex,
} from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

import { Logger } from '@nestjs/common';

import {
  AccountId,
  AssetId,
  ChainId,
  parseAccountId,
  parseAssetId,
  toAccountId,
} from '../ports/caip.types';
import { ChainErrors } from '../errors/chains.errors';
import {
  oneByOne,
  SlashBatchOutcome,
  SlashCancelIntent,
  SlashCancelRequest,
  SlashCancelResult,
  SlashExecutionRequest,
  SlashExecutionResult,
  SlashExecutorPort,
  SlashProposalRequest,
  SlashProposalResult,
  SlashRecordReadOptions,
  SlashRecordSnapshot,
} from '@modules/slash/ports/slash-executor.port';
import { SlashCaps, SlashCapsReaderPort } from '@modules/slash/ports/slash-caps-reader.port';
import {
  SlashBatchBuild,
  SlashChainTerms,
  SlashContractCall,
  SlashDisputeIntentPort,
  SlashIdRefusal,
  SlashRuling,
} from '@modules/slash/ports/slash-dispute-intent.port';
import { slashRecordMismatch } from '@modules/slash/domain/prorata-slash';
import { SigningRequesterType } from '@modules/verification/signing/domain/signing-journal';

import { evmErrorName, revertDataOf } from './abi/error-selectors';
import {
  MULTICALL3_ABI,
  ASSAY_CONFIG_ABI,
  ASSAY_CONFIG_ARBITER_ABI,
  ASSAY_STAKE_ABI,
  ASSAY_SLASH_WATCH_EVENTS_ABI,
  ASSAY_STAKE_SLASH_ABI,
} from './abi/assay.abi';
import { evmDomain } from './eip712/domain';
import {
  EVM_RESPONSE_CLASS_DATA_FAIL,
  EvmSlashAttestation,
  hashSlashAttestation,
} from './eip712/slash-attestation';
import { readConfigTerms } from './evm-config-terms';
import { EvmSlashRecord, readSlashRecord } from './evm-slash-record';
import { cancelReasonFromEvm, slashStatusFromEvm } from './evm-slash-status';
import { EVM_CONSTANTS, EvmDeployment } from './evm.constants';
import {
  EVM_FEE_CAP_WAIVED_WITHIN_SECONDS,
  estimateL1Gas,
  exceedsCostCap,
  paddedL1Gas,
} from './evm-l1-gas';
import { isSendRejected } from './evm-send-rejected.error';
import { FEE_SPIKE_DEFERRED } from '@modules/payment/ports/voucher-redeemer.port';
import { EvmRelayerPort } from './ports/evm-relayer.port';

/**
 * The part of a viem public client this class reads and simulates through.
 * Structural, so a test hands it a fake; `SanctionedEvmClient` satisfies it.
 */
export interface EvmSlashClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
  /** `eth_call` — the simulation that names a refusal before any gas is spent. */
  call(args: {
    account: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
  }): Promise<{ data?: `0x${string}` }>;
  estimateGas(args: {
    account: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
  }): Promise<bigint>;
  /**
   * Review R2-8: the two reads that find a cancelled record's `SlashCancelled`
   * (its reason). Optional: a client without them reads the reason as unknown.
   */
  getBlockNumber?(args?: { cacheTime?: number }): Promise<bigint>;
  getContractEvents?(args: {
    address: `0x${string}`;
    abi: typeof ASSAY_SLASH_WATCH_EVENTS_ABI;
    eventName: 'SlashCancelled';
    args: { requestId: `0x${string}` };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly { args: { reason?: number; cancelledAt?: bigint } }[]>;
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    status: 'success' | 'reverted';
    blockNumber: bigint;
    gasUsed: bigint;
    logs: readonly { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }[];
  }>;
}

/**
 * The two methods this class needs from `VerifierSigningService`. Resolved
 * through `ModuleRef` at call time, for the same reason and with the same
 * failure mode as `SolanaSlashExecutor`: only the processes that import
 * `VerifierSigningModule` (worker, scheduler) can sign, and anywhere else the
 * first attempt fails loudly instead of at boot.
 */
export interface EvmAttestationSigner {
  sign(request: {
    chainId: ChainId;
    purpose: string;
    requestId: string | null;
    requestedBy: { type: SigningRequesterType; id: string };
    payload: Uint8Array;
  }): Promise<{ signature: Uint8Array; publicKey: Uint8Array }>;
  /** The active key's raw public key — to recognise records this platform signed. */
  publicKey(chainId: ChainId): Promise<Uint8Array>;
}

export interface EvmSlashExecutorConfig {
  /** Milliseconds. The chain's timestamps are seconds. */
  readonly now: () => number;
  /**
   * Most judgements per `aggregate3` transaction. Beyond it the batch is
   * chunked; each chunk is simulated, estimated and sent on its own.
   */
  readonly batchSize: number;
  /**
   * `Multicall3` per chain. A chain absent from the map is served one
   * transaction per judgement — batching is an optimisation, never a
   * requirement.
   */
  readonly multicall: ReadonlyMap<ChainId, `0x${string}`>;
  /** Between receipt reads after a send. Default 1 s. */
  readonly receiptRetryDelayMs?: number;
  /**
   * The EIP-712 domain guard (`EvmChainStateService.domainRefusal`): while the
   * Stake proxy signs under another domain, no attestation is signed — it
   * would not recover to the verifier on chain. Absent: no guard.
   */
  readonly domains?: { domainRefusal(chainId: string): Error | null };
}

const RECEIPT_ATTEMPTS = 3;

/** Default `EVM_SLASH_BATCH_SIZE`. */
export const DEFAULT_EVM_SLASH_BATCH_SIZE = 20;

/**
 * Gas headroom over the EXECUTION part of `eth_estimateGas`, and the ceiling
 * that part may not exceed. On Nitro the estimate also carries the L1 data fee
 * in L2 gas (`evm-l1-gas.ts`). That part is read on its own and added padded
 * 20 %, outside the ceiling: it is a fee that spikes, not a property of the
 * call. 1.3× is the margin, and 10M is a third of `maxTxGasLimit` (32M) on 46630.
 */
const GAS_HEADROOM_NUMERATOR = 13n;
const GAS_HEADROOM_DENOMINATOR = 10n;
export const EVM_SLASH_MAX_GAS = 10_000_000n;

/**
 * The most wei one slash send may cost per request it carries, at the L2
 * basefee: 0.00005 ETH, the background sends' cap. An `executeSlash` costs about
 * 3e-6 ETH at 0.02 gwei, so only an extreme L1 spike is deferred. The send is
 * then refused unnamed (`FeeSpikeDeferred: …`) and the case is retried on a
 * later tick. Waived when an execution is within
 * `EVM_FEE_CAP_WAIVED_WITHIN_SECONDS` of its deadline (`executableAt` + the
 * 7-day grace), after which anyone may expire the record and the harmed agent
 * is never paid.
 */
export const EVM_SLASH_SEND_MAX_COST_WEI_PER_ITEM = 50_000_000_000_000n;

/** How long a signed attestation stays valid, and how far back `issuedAt` is put. */
const ATTESTATION_VALIDITY_SECONDS = 600n;
/** The chain's clock may trail this process's; `issuedAt > block.timestamp` reverts. */
const ATTESTATION_BACKDATE_SECONDS = 60n;

/**
 * How long after `executableAt` a `Pending` record stays executable before
 * `expireSlash` may reap it: the 7-day execution grace. The verifier key has to
 * outlive the record for that whole span, because `executeSlash` re-checks it
 * (review S-7).
 */
const RECORD_EXECUTION_GRACE_SECONDS = 7n * 86_400n;

const SUBMITTER_IDENTITY = 'evm-slash-executor';
const PROPOSE_ATTESTATION_PURPOSE = 'settlement.evm.propose_slash.attestation';

/** Review R2-8: blocks per `eth_getLogs` when looking up a cancel's event (the watcher's chunk). */
const CANCEL_LOOKUP_CHUNK = 2_000n;
/** Review R2-8: how many chunks back that lookup reads at most. */
const CANCEL_LOOKUP_CHUNKS = 5;

/**
 * `SlashExecutorPort` for `eip155` — `AssayStake`'s two-phase slash.
 *
 * ## The authority is the verifier's signature, never this process
 *
 * `proposeSlash(SlashAttestation, sig)` recovers the signer of the EIP-712
 * digest and calls `CONFIG.assertCanSign(signer)`; the relayer EOA that sends
 * the transaction is consulted about nothing. So this class signs every
 * attestation through `VerifierSigningService` (journalled, rate-limited) and
 * has no door that slashes without one — the same rule the Solana executor
 * keeps.
 *
 * ## Batching
 *
 * `executeSlash` has no `msg.sender` restriction, so the due executions go
 * out in ONE `Multicall3.aggregate3` per chunk of
 * {@link EvmSlashExecutorConfig.batchSize}, every call `allowFailure: true`.
 * Proposals do NOT: each carries a signed attestation, and a failed sub-call
 * would leave it valid and unused in public calldata (review 2026-10-23 L-1),
 * so each goes in its own transaction ({@link proposeBatch}). A multicall
 * receipt carries no per-call return data, so each execution chunk is:
 *
 *  1. **simulated** with `eth_call`, which returns `Result[]` — a call that
 *     would fail is taken out of the batch before any gas is spent;
 *  2. estimated and sent;
 *  3. **confirmed from the receipt's events** (`SlashExecuted`), matched on
 *     the indexed `requestId`.
 *
 * Anything that failed in simulation, failed inside the batch, or cannot be
 * confirmed (the send threw — it may have landed) is **retried once through
 * the single door**, which simulates again and either submits, adopts a
 * record already on chain (`SlashAlreadyExists` on a retry is success
 * already), or throws the named refusal. Nothing is dropped: a batch of N
 * answers N outcomes. Idempotency is the deterministic `requestId` — the
 * contract admits one record per id, ever.
 *
 * ## Where EVM differs from the Solana record
 *
 * `SlashRecord` on EVM does not store the agent and platform amounts — only
 * `applied`. The live paths read both off the `SlashExecuted` event in their
 * own receipt, exactly as paid. {@link readRecord}, the recovery path for a
 * record somebody else executed, has no receipt and derives them from
 * `applied` with `Fee.bpsOf` at the CURRENT `slashAgentBps`/`slashPlatformBps`;
 * that differs from what was paid only if an admin changed the split between
 * the execution and the read. There is no `cancelledAt` either; a cancel's
 * time comes from its own event.
 */
export class EvmSlashExecutor
  implements SlashExecutorPort, SlashCapsReaderPort, SlashDisputeIntentPort
{
  private readonly logger = new Logger(EvmSlashExecutor.name);

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmSlashClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    private readonly relayer: EvmRelayerPort,
    private readonly signers: { get(token: unknown, options?: { strict: boolean }): unknown },
    private readonly signerToken: unknown,
    private readonly config: EvmSlashExecutorConfig,
  ) {}

  // ── Reads ───────────────────────────────────────────────────────────────

  async settlementTreasury(asset: AssetId): Promise<AccountId> {
    const { chainId } = parseAssetId(asset);
    const params = await this.params(chainId);
    return toAccountId(chainId, getAddress(params.treasury));
  }

  async readCaps(request: { chainId: ChainId; provider: string }): Promise<SlashCaps> {
    const { chainId } = request;
    const provider = this.address(request.provider, 'provider');
    const [params, stake] = await Promise.all([
      this.params(chainId),
      this.client(chainId).readContract({
        address: this.deployment(chainId).stake,
        abi: ASSAY_STAKE_ABI,
        functionName: 'stakeOf',
        args: [provider],
      }) as Promise<{ bonded: bigint; unbonding: bigint; pendingSlash: bigint }>,
    ]);
    // `_atRisk` = bonded + unbonding; `capAllowance` and `free` exactly as
    // `proposeSlash` computes them (AssayStake.sol, `proposeSlash`).
    const atRisk = BigInt(stake.bonded) + BigInt(stake.unbonding);
    const pending = BigInt(stake.pendingSlash);
    return {
      penaltyCeilingMinor: BigInt(params.penaltyAmount),
      windowAllowanceMinor: (atRisk * BigInt(params.slashCapBps)) / 10_000n,
      freeStakeMinor: atRisk > pending ? atRisk - pending : 0n,
      pendingSlashMinor: pending,
      verifierDailyCapMinor: BigInt(params.verifierDailyCap),
      agentBps: Number(params.slashAgentBps),
      platformBps: Number(params.slashPlatformBps),
    };
  }

  async readRecord(
    requestId: string,
    provider: string,
    chainId: ChainId,
    options?: SlashRecordReadOptions,
  ): Promise<SlashRecordSnapshot | null> {
    const record = await this.fetchRecord(
      chainId,
      requestId,
      options?.finalized ? 'finalized' : undefined,
    );
    if (!record) return null;
    this.assertRecordProvider(record, provider, requestId);

    const status = slashStatusFromEvm(Number(record.status));
    if (!status) return null;

    let agentAmount = 0n;
    let platformAmount = 0n;
    if (status === 'EXECUTED') {
      // See the class comment: the EVM record does not freeze the split.
      const params = await this.params(chainId);
      agentAmount = (record.applied * BigInt(params.slashAgentBps)) / 10_000n;
      platformAmount = (record.applied * BigInt(params.slashPlatformBps)) / 10_000n;
    }

    return {
      status,
      penaltyMinor: record.penalty.toString(),
      appliedMinor: record.applied.toString(),
      agentAmountMinor: agentAmount.toString(),
      platformAmountMinor: platformAmount.toString(),
      reservedMinor: record.reserved.toString(),
      proposedAt: secondsToDate(record.proposedAt),
      executableAt: secondsToDate(record.executableAt),
      executedAt: record.executedAt === 0n ? null : secondsToDate(record.executedAt),
      ...(status === 'CANCELLED' ? await this.cancelOf(chainId, requestId) : { cancelledAt: null }),
      disputedAt: record.disputedAt === 0n ? null : secondsToDate(record.disputedAt),
      beneficiary: getAddress(record.beneficiary),
      policy: record.policy,
      verifier: getAddress(record.verifier),
      ...(await this.verifierStanding(chainId, record.verifier)),
    };
  }

  /**
   * Review R2-8: a cancelled record's reason and time, off its own
   * `SlashCancelled` event (the record keeps neither). Read newest blocks
   * first, {@link CANCEL_LOOKUP_CHUNK} blocks per `eth_getLogs`, at most
   * {@link CANCEL_LOOKUP_CHUNKS} chunks back: a chain read observes a cancel
   * soon after it lands, and an older one is the watcher's to mirror. Not
   * found, or the read failed: the reason stays unknown (`null`), never
   * guessed.
   */
  private async cancelOf(
    chainId: ChainId,
    requestId: string,
  ): Promise<{ cancelledAt: Date | null; cancelReason: string | null }> {
    const unknown = { cancelledAt: null, cancelReason: null };
    const client = this.client(chainId);
    if (!client.getBlockNumber || !client.getContractEvents) return unknown;
    try {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      let toBlock = head;
      for (let chunk = 0; chunk < CANCEL_LOOKUP_CHUNKS; chunk += 1) {
        const fromBlock = toBlock >= CANCEL_LOOKUP_CHUNK ? toBlock - CANCEL_LOOKUP_CHUNK + 1n : 0n;
        const logs = await client.getContractEvents({
          address: this.deployment(chainId).stake,
          abi: ASSAY_SLASH_WATCH_EVENTS_ABI,
          eventName: 'SlashCancelled',
          args: { requestId: bytes32(requestId) },
          fromBlock,
          toBlock,
        });
        const found = logs[logs.length - 1];
        if (found?.args.reason !== undefined) {
          return {
            cancelReason: cancelReasonFromEvm(Number(found.args.reason)),
            cancelledAt:
              found.args.cancelledAt !== undefined ? secondsToDate(found.args.cancelledAt) : null,
          };
        }
        if (fromBlock === 0n) break;
        toBlock = fromBlock - 1n;
      }
    } catch (error) {
      this.logger.warn(
        `slash record ${requestId}: its SlashCancelled could not be read (${
          error instanceof Error ? error.message : String(error)
        }); its cancel reason stays unknown`,
      );
    }
    return unknown;
  }

  /**
   * Whether a record's verifier may still sign (`CONFIG.canSign`) and whether
   * it is acceptable as ours: this platform's own key, or a key the chain
   * still allows — a rotation. A process with no signer cannot claim the key
   * as its own and answers on `canSign` alone.
   */
  private async verifierStanding(
    chainId: ChainId,
    verifier: string,
  ): Promise<{ verifierCanSign: boolean; verifierAccepted: boolean }> {
    const verifierCanSign = (await this.client(chainId).readContract({
      address: this.deployment(chainId).config,
      abi: ASSAY_CONFIG_ABI,
      functionName: 'canSign',
      args: [getAddress(verifier)],
    })) as boolean;
    let ours = false;
    try {
      ours = (await this.verifierAddress(chainId)) === getAddress(verifier);
    } catch {
      ours = false;
    }
    return { verifierCanSign, verifierAccepted: ours || verifierCanSign };
  }

  // ── Phase one ───────────────────────────────────────────────────────────

  async propose(request: SlashProposalRequest): Promise<SlashProposalResult> {
    return this.proposeOne(request);
  }

  /**
   * One transaction per judgement, never a `Multicall3` batch (review
   * 2026-10-23 L-1). A proposal carries a signed attestation in its calldata;
   * inside `aggregate3` with `allowFailure: true` a sub-call that failed on
   * chain still published its valid, unused attestation in a successful
   * transaction, and with `allowFailure: false` one failing item would publish
   * every other one's. Alone, each attestation is signed immediately before
   * its own simulation and send (`proposeOne`), and only a revert between that
   * simulation and inclusion can expose it — that one, for its validity of
   * {@link ATTESTATION_VALIDITY_SECONDS}. Proposals are a few per window, so
   * the throughput is the relayer's, one receipt each. Executions carry no
   * signature and stay batched.
   */
  async proposeBatch(
    requests: readonly SlashProposalRequest[],
  ): Promise<readonly SlashBatchOutcome<SlashProposalResult>[]> {
    return oneByOne(requests, (request) => this.proposeOne(request));
  }

  // ── Phase two ───────────────────────────────────────────────────────────

  async executeProposal(request: SlashExecutionRequest): Promise<SlashExecutionResult> {
    const [outcome] = await this.executeBatch([request]);
    if (!outcome.ok) throw outcome.error;
    return outcome.result as SlashExecutionResult;
  }

  /**
   * Execute every request, batched per chain.
   *
   * **All or wait** (assay-evm 9f036a3): `executeSlash` pays exactly the
   * record's `reserved`, or reverts `SlashWindowNotDrained` while the
   * provider's rolling window cannot take all of it. (The verifier key's own
   * daily window is no longer applied at execution, review 2026-10-23 M-1:
   * shared by every provider, it let one provider's self-slashes crowd out
   * everybody else's.)
   * There is no partial payment, so nothing has to be simulated or deferred
   * to keep a case from being cut short by order: a part that cannot be paid
   * whole waits (a WAIT) and the next tick retries it.
   */
  async executeBatch(
    requests: readonly SlashExecutionRequest[],
  ): Promise<readonly SlashBatchOutcome<SlashExecutionResult>[]> {
    return this.batch<SlashExecutionRequest, SlashExecutionResult>(requests, {
      single: (request, knownHash) => this.executeOne(request, knownHash),
      prepare: async (request) => {
        const record = await this.assertExecutable(request);
        return {
          callData: this.executeCallData(request.requestId),
          urgent: this.executionNearDeadline(record),
        };
      },
      confirm: async (request, receipt, hash) =>
        this.executionResultFromReceipt(request, receipt, hash),
      instruction: 'executeSlash',
    });
  }

  async expire(request: SlashCancelRequest): Promise<SlashCancelResult> {
    const { chainId } = request;
    const record = await this.fetchRecord(chainId, request.requestId);
    if (!record) throw ChainErrors.slashRecordNotFound({ requestId: request.requestId });
    this.assertRecordProvider(record, request.provider, request.requestId);

    const stake = this.deployment(chainId).stake;
    const data = encodeFunctionData({
      abi: ASSAY_STAKE_SLASH_ABI,
      functionName: 'expireSlash',
      args: [bytes32(request.requestId)],
    });
    const { hash, receipt } = await this.simulateAndSend(chainId, stake, data, 'expireSlash');
    const cancelled = receipt
      ? findEvent(receipt, stake, 'SlashCancelled', request.requestId)
      : null;
    const cancelledAt = cancelled
      ? secondsToDate(BigInt((cancelled.args as { cancelledAt: bigint }).cancelledAt))
      : new Date(this.config.now());
    const reason = cancelled
      ? cancelReasonFromEvm(Number((cancelled.args as { reason: number }).reason))
      : undefined;
    return { signature: hash, cancelledAt, ...(reason ? { reason } : {}) };
  }

  /**
   * `expireSlash` for many records at once (review 2026-10-24 wave 2 M-2):
   * through `Multicall3` where the chain has one, else one transaction each,
   * with the same simulate-then-send, adopt-or-retry-singly rules as
   * `executeBatch`. `expireSlash` is permissionless, so the relayer sends it;
   * since assay-evm D-27 it releases at once a record whose verifier can no
   * longer sign. A record already released makes its row fail
   * (`SlashNotPending`) without touching the others.
   */
  async expireBatch(
    requests: readonly SlashCancelRequest[],
  ): Promise<readonly SlashBatchOutcome<SlashCancelResult>[]> {
    return this.batch<SlashCancelRequest, SlashCancelResult>(requests, {
      single: (request) => this.expire(request),
      prepare: async (request) => ({
        callData: encodeFunctionData({
          abi: ASSAY_STAKE_SLASH_ABI,
          functionName: 'expireSlash',
          args: [bytes32(request.requestId)],
        }),
      }),
      confirm: async (request, receipt, hash) => {
        const stake = this.deployment(request.chainId).stake;
        const cancelled = findEvent(receipt, stake, 'SlashCancelled', request.requestId);
        if (!cancelled) return null;
        const args = cancelled.args as { cancelledAt: bigint; reason: number };
        return {
          signature: hash,
          cancelledAt: secondsToDate(BigInt(args.cancelledAt)),
          reason: cancelReasonFromEvm(Number(args.reason)),
        };
      },
      instruction: 'expireSlash',
    });
  }

  /**
   * The unsigned `cancelSlash` for the ARBITER, the only person this backend
   * builds a cancel for (assay-evm D-19: an overturn or a suspension is the
   * arbiter's `cancelSlash`, so the admin key stays cold). The arbiter is
   * required: an unset arbiter is `CHAIN_ARBITER_NOT_SET`. Built, never sent:
   * this process holds no such key. `cancelSlash` accepts a `Pending` or a
   * `Disputed` record.
   */
  async buildCancel(request: SlashCancelRequest): Promise<SlashCancelIntent> {
    const { chainId } = request;
    const record = await this.fetchRecord(chainId, request.requestId);
    if (!record) throw ChainErrors.slashRecordNotFound({ requestId: request.requestId });
    this.assertRecordProvider(record, request.provider, request.requestId);

    const deployment = this.deployment(chainId);
    const terms = await this.chainTerms(chainId);
    if (!terms.arbiter) throw ChainErrors.arbiterNotSet({ chainId, what: 'cancelSlash' });
    const signer = terms.arbiter;

    return {
      transaction: encodeFunctionData({
        abi: ASSAY_STAKE_SLASH_ABI,
        functionName: 'cancelSlash',
        args: [bytes32(request.requestId)],
      }),
      to: deployment.stake,
      admin: signer,
      signerRole: 'ARBITER',
      requestId: request.requestId,
      provider: request.provider,
      blockhash: '',
      lastValidBlockHeight: '0',
    };
  }

  // ── The dispute upgrade's intents (D-19) ────────────────────────────────

  /** The Config's dispute terms, read live. Any read failure is thrown (an RPC error). */
  async chainTerms(chainId: ChainId): Promise<SlashChainTerms> {
    const deployment = this.deployment(chainId);
    const client = this.client(chainId);
    const [terms, admin, params] = await Promise.all([
      readConfigTerms(client, deployment.config),
      client.readContract({
        address: deployment.config,
        abi: ASSAY_CONFIG_ABI,
        functionName: 'admin',
        args: [],
      }) as Promise<`0x${string}`>,
      client.readContract({
        address: deployment.config,
        abi: ASSAY_CONFIG_ABI,
        functionName: 'params',
        args: [],
      }) as Promise<{ slashAgentBps: number | bigint; slashPlatformBps: number | bigint }>,
    ]);
    return {
      chainId,
      ...terms,
      admin: getAddress(admin),
      slashAgentBps: Number(params.slashAgentBps),
      slashPlatformBps: Number(params.slashPlatformBps),
    };
  }

  /**
   * The delay a record proposed NOW will freeze into its `executableAt`:
   * `slashDelaySeconds()`, read live. A failed read throws; the caller
   * retries on its next tick. Never assumed.
   */
  async slashDelaySeconds(chainId: ChainId): Promise<number> {
    const delay = (await this.client(chainId).readContract({
      address: this.deployment(chainId).config,
      abi: ASSAY_CONFIG_ABI,
      functionName: 'slashDelaySeconds',
      args: [],
    })) as bigint;
    return Number(delay);
  }

  /**
   * `disputeSlashBatch(ids)` for the provider's own stake wallet, every id
   * pre-checked against `_dispute`'s rule: the record exists, names this
   * provider, is `Pending`, was never disputed before (`disputedAt == 0`), and its
   * dispute window (`executableAt − now`) is
   * still open. Neither the pause nor the blocklist closes this door, so a
   * blocked provider gets an intent too.
   */
  async buildDisputeBatch(request: {
    readonly chainId: ChainId;
    readonly provider: string;
    readonly requestIds: readonly string[];
  }): Promise<SlashBatchBuild> {
    const { chainId } = request;
    const provider = this.address(request.provider, 'provider');
    const ids = this.batchIds(request.requestIds);
    const nowSeconds = BigInt(Math.floor(this.config.now() / 1000));

    const refusals = await this.precheck(chainId, ids, (id, record) => {
      if (getAddress(record.provider) !== provider) {
        return refusal(id, 'NotSlashedProvider', 'the record names a different provider');
      }
      if (slashStatusFromEvm(record.status) !== 'PENDING') {
        return refusal(
          id,
          'SlashNotPending',
          `the record is ${slashStatusFromEvm(record.status)}, and only a PENDING record can be disputed`,
        );
      }
      // A record may be disputed once: after an uphold it is Pending again
      // with `disputedAt` kept, and the contract refuses a second dispute,
      // which would revert the whole atomic batch (audit E-9).
      if (record.disputedAt > 0n) {
        return refusal(
          id,
          'SlashAlreadyDisputed',
          `the record was already disputed at ${secondsToDate(record.disputedAt).toISOString()}`,
        );
      }
      if (nowSeconds >= record.executableAt) {
        return refusal(
          id,
          'DisputeWindowClosed',
          `the dispute window closed at ${secondsToDate(record.executableAt).toISOString()}`,
        );
      }
      return null;
    });
    if (refusals.length > 0) return { call: null, refusals };

    return {
      call: this.stakeCall(chainId, 'disputeSlashBatch', ids, provider, 'PROVIDER'),
      refusals: [],
    };
  }

  /**
   * The arbiter's ruling over many records. `UPHOLD` → `upholdSlashBatch`
   * (arbiter only; each record `Disputed`, inside `disputedAt + 30 d`, and not
   * judged by the arbiter's own key — and an uphold does NOT necessarily make
   * the record executable at once: the new `executableAt` is read back from
   * `SlashUpheld` or `slashRecordOf`, never assumed); `CANCEL` →
   * `cancelSlashBatch` (each record `Pending` or `Disputed`), for the arbiter.
   * Both need the arbiter set.
   */
  async buildRulingBatch(request: {
    readonly chainId: ChainId;
    readonly ruling: SlashRuling;
    readonly requestIds: readonly string[];
  }): Promise<SlashBatchBuild> {
    const { chainId, ruling } = request;
    const terms = await this.chainTerms(chainId);
    if (!terms.arbiter) {
      throw ChainErrors.arbiterNotSet({
        chainId,
        what: ruling === 'UPHOLD' ? 'upholdSlashBatch' : 'cancelSlashBatch',
      });
    }
    const ids = this.batchIds(request.requestIds);
    const arbiter = terms.arbiter;
    const nowSeconds = BigInt(Math.floor(this.config.now() / 1000));

    const refusals = await this.precheck(chainId, ids, (id, record) => {
      const status = slashStatusFromEvm(record.status);
      if (ruling === 'UPHOLD') {
        if (status !== 'DISPUTED') {
          return refusal(id, 'SlashNotDisputed', `the record is ${status}, not DISPUTED`);
        }
        // The contract refuses an uphold after `disputedAt + 30 d`: past it the
        // record is only `expireSlash`-able (DisputeUnresolved).
        if (
          record.disputedAt > 0n &&
          nowSeconds >= record.disputedAt + BigInt(EVM_CONSTANTS.DISPUTE_TIMEOUT_SECONDS)
        ) {
          return refusal(
            id,
            'DisputeTimedOut',
            'the dispute went unruled for 30 days; the record can only be expired now',
          );
        }
        return null;
      }
      if (status !== 'PENDING' && status !== 'DISPUTED') {
        return refusal(id, 'SlashNotPending', `the record is ${status}; nothing is left to cancel`);
      }
      return null;
    });
    if (refusals.length > 0) return { call: null, refusals };

    return {
      call:
        ruling === 'UPHOLD'
          ? this.stakeCall(chainId, 'upholdSlashBatch', ids, arbiter as string, 'ARBITER')
          : this.stakeCall(chainId, 'cancelSlashBatch', ids, arbiter as string, 'ARBITER'),
      refusals: [],
    };
  }

  /**
   * `setBlocked(account, true)` for the arbiter. Block ONLY: the contract lets
   * the arbiter block and nobody but the admin unblock, so there is no
   * unblock intent here at all.
   */
  async buildBlock(request: {
    readonly chainId: ChainId;
    readonly account: string;
  }): Promise<SlashContractCall> {
    const { chainId } = request;
    const account = this.address(request.account, 'account');
    if (BigInt(account) === 0n) {
      throw ChainErrors.payloadMalformed({ reason: 'the zero address cannot be blocked' });
    }
    const terms = await this.chainTerms(chainId);
    if (!terms.arbiter) throw ChainErrors.arbiterNotSet({ chainId, what: 'setBlocked' });
    const config = this.deployment(chainId).config;
    await this.assertNotPlatformAddress(chainId, account, terms);
    const already = (await this.client(chainId).readContract({
      address: config,
      abi: ASSAY_CONFIG_ABI,
      functionName: 'blocked',
      args: [account],
    })) as boolean;
    if (already) throw ChainErrors.addressAlreadyBlocked({ chainId, account });
    return {
      chainId,
      to: getAddress(config),
      data: encodeFunctionData({
        abi: ASSAY_CONFIG_ARBITER_ABI,
        functionName: 'setBlocked',
        args: [account, true],
      }),
      value: '0',
      signer: terms.arbiter,
      signerRole: 'ARBITER',
      functionName: 'setBlocked',
      requestIds: [],
    };
  }

  /**
   * Refuse a block of the platform's own configured addresses (audit E-12),
   * each read live: the treasury and the redeemer (`params()`), the admin, the
   * owner, the arbiter, any registered verifier (`canSign`), and the three
   * contracts themselves.
   */
  private async assertNotPlatformAddress(
    chainId: ChainId,
    account: `0x${string}`,
    terms: SlashChainTerms,
  ): Promise<void> {
    const deployment = this.deployment(chainId);
    const client = this.client(chainId);
    const read = (functionName: string, args: readonly unknown[] = []) =>
      client.readContract({
        address: deployment.config,
        abi: ASSAY_CONFIG_ABI,
        functionName,
        args,
      });
    const [params, owner, isVerifier] = await Promise.all([
      read('params') as Promise<{ treasury: `0x${string}`; redeemer: `0x${string}` }>,
      read('owner') as Promise<`0x${string}`>,
      read('canSign', [account]) as Promise<boolean>,
    ]);
    const roles: [string, string | null | undefined][] = [
      ['treasury', params.treasury],
      ['redeemer', params.redeemer],
      ['admin', terms.admin],
      ['owner', owner],
      ['arbiter', terms.arbiter],
      ['config contract', deployment.config],
      ['stake contract', deployment.stake],
      ['escrow contract', deployment.escrow],
    ];
    const hit = roles.find(([, address]) => address && getAddress(address) === account);
    if (hit) {
      throw ChainErrors.platformAddressNotBlockable({ chainId, account, role: hit[0] });
    }
    if (isVerifier) {
      throw ChainErrors.platformAddressNotBlockable({ chainId, account, role: 'verifier key' });
    }
  }

  /** 1 to `MAX_SLASH_BATCH` well-formed ids, lower-case, in the caller's order. */
  private batchIds(requestIds: readonly string[]): `0x${string}`[] {
    if (requestIds.length === 0 || requestIds.length > EVM_CONSTANTS.MAX_SLASH_BATCH) {
      throw ChainErrors.payloadMalformed({
        reason: `a slash batch carries 1 to ${EVM_CONSTANTS.MAX_SLASH_BATCH} request ids, got ${requestIds.length}`,
      });
    }
    return requestIds.map((id) => bytes32(id));
  }

  /**
   * Every id read with `slashRecordOf` and judged by `rule`. A duplicate is
   * refused on its second occurrence — the contract's second iteration would
   * find the record already moved and revert the batch.
   */
  private async precheck(
    chainId: ChainId,
    ids: readonly `0x${string}`[],
    rule: (id: string, record: EvmSlashRecord) => SlashIdRefusal | null,
  ): Promise<SlashIdRefusal[]> {
    const seen = new Set<string>();
    const records = await Promise.all(ids.map((id) => this.fetchRecord(chainId, id)));
    const refusals: SlashIdRefusal[] = [];
    ids.forEach((id, index) => {
      const bare = id.slice(2);
      if (seen.has(bare)) {
        refusals.push(refusal(bare, 'DuplicateId', 'the id appears more than once in the batch'));
        return;
      }
      seen.add(bare);
      const record = records[index];
      if (!record) {
        refusals.push(refusal(bare, 'NoSuchRecord', 'no slash record exists for this id'));
        return;
      }
      const refused = rule(bare, record);
      if (refused) refusals.push(refused);
    });
    return refusals;
  }

  private stakeCall(
    chainId: ChainId,
    functionName: 'disputeSlashBatch' | 'upholdSlashBatch' | 'cancelSlashBatch',
    ids: readonly `0x${string}`[],
    signer: string,
    signerRole: SlashContractCall['signerRole'],
  ): SlashContractCall {
    return {
      chainId,
      to: getAddress(this.deployment(chainId).stake),
      data: encodeFunctionData({ abi: ASSAY_STAKE_SLASH_ABI, functionName, args: [ids] }),
      value: '0',
      signer: getAddress(signer),
      signerRole,
      functionName,
      requestIds: ids.map((id) => id.slice(2)),
    };
  }

  // ── Internals: the single doors ─────────────────────────────────────────

  private async proposeOne(request: SlashProposalRequest): Promise<SlashProposalResult> {
    const adopted = await this.adoptIfPresent(request);
    if (adopted) return adopted;

    // Signed here, immediately before its own simulation and send.
    const { callData } = await this.attest(request);
    const stake = this.deployment(request.chainId).stake;

    let hash: `0x${string}`;
    try {
      ({ hash } = await this.simulateAndSend(request.chainId, stake, callData, 'proposeSlash'));
    } catch (error) {
      // Lost a race, or a previous attempt landed: the record decides, never
      // the error text. `SlashAlreadyExists` is success-already.
      const raced = await this.adoptIfPresent(request);
      if (raced) return raced;
      throw error;
    }
    return this.proposalResultFromRecord(request, hash, false);
  }

  /**
   * @param knownHash a batch transaction that may already have executed this
   *   record — when the record says Executed, its receipt is where the exact
   *   amounts are, so they are read from there rather than recomputed.
   */
  private async executeOne(
    request: SlashExecutionRequest,
    knownHash: `0x${string}` | null = null,
  ): Promise<SlashExecutionResult> {
    if (knownHash) {
      const record = await this.fetchRecord(request.chainId, request.requestId);
      if (record && slashStatusFromEvm(record.status) === 'EXECUTED') {
        const receipt = await this.receiptOf(request.chainId, knownHash);
        const result = receipt
          ? await this.executionResultFromReceipt(request, receipt, knownHash)
          : null;
        if (result) return result;
      }
    }
    const record = await this.assertExecutable(request);
    const stake = this.deployment(request.chainId).stake;
    const { hash, receipt } = await this.simulateAndSend(
      request.chainId,
      stake,
      this.executeCallData(request.requestId),
      'executeSlash',
      this.executionNearDeadline(record),
    );
    const result = receipt ? await this.executionResultFromReceipt(request, receipt, hash) : null;
    if (!result) {
      // Landed, but the receipt could not be read (or carried no event, which
      // the contract cannot produce). Unnamed on purpose: the caller reads the
      // record, and the case is reconciled rather than guessed.
      throw ChainErrors.transactionFailed({
        instruction: 'executeSlash',
        signature: hash,
        reason: 'executed, but the receipt could not be read for this request',
        customErrorCode: null,
      });
    }
    return result;
  }

  // ── Internals: the batch engine ─────────────────────────────────────────

  private async batch<Request extends { chainId: ChainId; requestId: string }, Result>(
    requests: readonly Request[],
    steps: {
      /** The single door. `knownHash`: a batch tx that may already have done it. */
      single: (request: Request, knownHash: `0x${string}` | null) => Promise<Result>;
      prepare: (
        request: Request,
      ) => Promise<{ done: Result } | { callData: `0x${string}`; urgent?: boolean }>;
      confirm: (request: Request, receipt: Receipt, hash: `0x${string}`) => Promise<Result | null>;
      instruction: string;
    },
  ): Promise<SlashBatchOutcome<Result>[]> {
    const outcomes: (SlashBatchOutcome<Result> | undefined)[] = new Array(requests.length);
    const retry: { index: number; knownHash: `0x${string}` | null; inFlight?: boolean }[] = [];

    // Grouped by chain: one multicall can only reach one chain.
    const byChain = new Map<ChainId, number[]>();
    requests.forEach((request, index) => {
      byChain.set(request.chainId, [...(byChain.get(request.chainId) ?? []), index]);
    });

    for (const [chainId, indexes] of byChain) {
      const multicall = this.config.multicall.get(chainId);
      if (!multicall || indexes.length === 1) {
        for (const index of indexes) retry.push({ index, knownHash: null });
        continue;
      }

      // Prepare: adopt what is already done, sign the rest.
      const ready: { index: number; callData: `0x${string}`; urgent?: boolean }[] = [];
      for (const index of indexes) {
        try {
          const step = await steps.prepare(requests[index]);
          if ('done' in step) outcomes[index] = { ok: true, result: step.done };
          else ready.push({ index, callData: step.callData, urgent: step.urgent });
        } catch (error) {
          outcomes[index] = { ok: false, error };
        }
      }

      const stake = this.deployment(chainId).stake;
      for (let start = 0; start < ready.length; start += this.config.batchSize) {
        const chunk = ready.slice(start, start + this.config.batchSize);
        // Every chunk is isolated: an RPC failure anywhere in it sends its rows
        // to the single door, and never touches another chunk.
        let live: typeof chunk;
        try {
          live = await this.simulateBatch(chainId, multicall, stake, chunk);
        } catch (error) {
          this.logger.warn(
            `${steps.instruction} chunk simulation on ${chainId} failed ` +
              `(${error instanceof Error ? error.message : String(error)}); retrying singly`,
          );
          for (const row of chunk) retry.push({ index: row.index, knownHash: null });
          continue;
        }
        for (const row of chunk) {
          if (!live.includes(row)) retry.push({ index: row.index, knownHash: null });
        }
        if (live.length === 0) continue;
        if (live.length === 1) {
          retry.push({ index: live[0].index, knownHash: null });
          continue;
        }

        let sent: { hash: `0x${string}`; receipt: Receipt | null } | null = null;
        let inFlight = false;
        try {
          sent = await this.sendBatch(chainId, multicall, stake, live, steps.instruction);
        } catch (error) {
          // Unless the chain itself refused the batch (a mined revert, a fee
          // deferral before signing) or the node refused it (never broadcast),
          // it may still be mined later carrying these requests.
          inFlight = !(
            isSendRejected(error) ||
            (error instanceof Error &&
              (error as { errorCode?: string }).errorCode === 'CHAIN_TRANSACTION_FAILED')
          );
          // It may have landed. The single door reads first and adopts.
          this.logger.warn(
            `${steps.instruction} batch of ${live.length} on ${chainId} failed to send ` +
              `(${error instanceof Error ? error.message : String(error)}); retrying singly`,
          );
        }

        for (const row of live) {
          const confirmed = sent?.receipt
            ? await steps.confirm(requests[row.index], sent.receipt, sent.hash).catch(() => null)
            : null;
          if (confirmed) outcomes[row.index] = { ok: true, result: confirmed };
          else retry.push({ index: row.index, knownHash: sent?.hash ?? null, inFlight });
        }
      }
    }

    // Once, singly, and the answer stands — success, adoption or the named refusal.
    retry.sort((left, right) => left.index - right.index);
    const singles = await oneByOne(retry, (row) =>
      steps.single(requests[row.index], row.knownHash),
    );
    singles.forEach((outcome, position) => {
      const row = retry[position];
      // A refusal of the single attempt says nothing about a batch that may
      // still be mined with the same request id. Reported UNNAMED — the
      // caller retries, re-reads `slashRecordOf`, and never closes the case on
      // it — so a late-landing record can never stand behind a voided case.
      outcomes[row.index] =
        row.inFlight && !outcome.ok
          ? {
              ok: false,
              error: ChainErrors.transactionFailed({
                instruction: steps.instruction,
                reason:
                  `a batch carrying ${requests[row.index].requestId} may still land; the single ` +
                  `retry was refused (${outcome.error instanceof Error ? outcome.error.message : 'unknown'})`,
                customErrorCode: null,
              }),
            }
          : outcome;
    });

    return outcomes.map(
      (outcome, index) =>
        outcome ?? {
          ok: false,
          error: ChainErrors.transactionFailed({
            instruction: steps.instruction,
            reason: `request ${requests[index].requestId} was given no outcome`,
            customErrorCode: null,
          }),
        },
    );
  }

  /** The rows of `chunk` that `aggregate3` reports as succeeding in `eth_call`. */
  private async simulateBatch<Row extends { callData: `0x${string}` }>(
    chainId: ChainId,
    multicall: `0x${string}`,
    stake: `0x${string}`,
    chunk: readonly Row[],
  ): Promise<Row[]> {
    const data = aggregate3(stake, chunk);
    const reply = await this.client(chainId).call({
      account: await this.relayerAddress(chainId),
      to: multicall,
      data,
    });
    const results = decodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      data: reply.data ?? '0x',
    }) as readonly { success: boolean; returnData: `0x${string}` }[];
    if (results.length !== chunk.length) {
      throw ChainErrors.rpcReplyMalformed({
        method: 'aggregate3',
        expected: chunk.length,
        actual: results.length,
      });
    }
    const live: Row[] = [];
    results.forEach((result, position) => {
      if (result.success) live.push(chunk[position]);
      else
        this.logger.debug(
          `simulated call ${position} reverts ${evmErrorName(result.returnData)}; retried singly`,
        );
    });
    return live;
  }

  private async sendBatch(
    chainId: ChainId,
    multicall: `0x${string}`,
    stake: `0x${string}`,
    live: readonly { callData: `0x${string}`; urgent?: boolean }[],
    instruction: string,
  ): Promise<{ hash: `0x${string}`; receipt: Receipt | null }> {
    const data = aggregate3(stake, live);
    const gasLimit = await this.gasFor(chainId, multicall, data, {
      items: live.length,
      urgent: live.some((row) => row.urgent === true),
      instruction: `aggregate3(${instruction})`,
    });
    const sent = await this.relayer.sendCall({
      chainId,
      to: toAccountId(chainId, multicall),
      data,
      gasLimit,
      purpose: `slash.${instruction}.batch`,
    });
    if (sent.status !== 'SUCCESS') {
      throw ChainErrors.transactionFailed({
        instruction: `aggregate3(${instruction})`,
        signature: sent.hash,
        reason: sent.revertReason ?? 'reverted',
        customErrorCode: null,
      });
    }
    const hash = sent.hash as `0x${string}`;
    // A landed batch whose receipt cannot be read is NOT a failed batch: the
    // hash travels with every row so the single door can read it later.
    const receipt = await this.receiptOf(chainId, hash);
    this.logger.log(
      `${instruction} × ${live.length} batched on ${chainId} in ${hash} — gasUsed ` +
        `${receipt?.gasUsed ?? 'unknown (receipt unreadable)'}`,
    );
    return { hash, receipt };
  }

  /** The receipt, read with retries; `null` (never a throw) when the node will not answer. */
  private async receiptOf(chainId: ChainId, hash: `0x${string}`): Promise<Receipt | null> {
    for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
      try {
        return await this.client(chainId).getTransactionReceipt({ hash });
      } catch (error) {
        if (attempt === RECEIPT_ATTEMPTS - 1) {
          this.logger.error(
            `the receipt of ${hash} on ${chainId} could not be read after ${RECEIPT_ATTEMPTS} ` +
              `attempts (${error instanceof Error ? error.message : String(error)})`,
          );
          return null;
        }
        await sleep(this.config.receiptRetryDelayMs ?? 1_000);
      }
    }
    return null;
  }

  /**
   * One transaction: simulate (a refusal is named without spending gas),
   * estimate, send, and read the receipt. A revert — in simulation or on
   * chain — is thrown as `CHAIN_TRANSACTION_FAILED` carrying the `Errors.sol`
   * name in `programErrorName`, which `chainErrorName` classifies. The
   * receipt is `null` when it could not be read after the send succeeded.
   */
  private async simulateAndSend(
    chainId: ChainId,
    to: `0x${string}`,
    data: `0x${string}`,
    instruction: string,
    urgent = false,
  ): Promise<{ hash: `0x${string}`; receipt: Receipt | null }> {
    const account = await this.relayerAddress(chainId);
    try {
      await this.client(chainId).call({ account, to, data });
    } catch (error) {
      const revert = revertDataOf(error);
      if (!revert) throw error; // the node did not answer; transient
      throw revertError(instruction, evmErrorName(revert), null);
    }

    const gasLimit = await this.gasFor(chainId, to, data, { items: 1, urgent, instruction });
    const sent = await this.relayer.sendCall({
      chainId,
      to: toAccountId(chainId, to),
      data,
      gasLimit,
      purpose: `slash.${instruction}`,
    });
    if (sent.status !== 'SUCCESS') {
      throw revertError(instruction, sent.revertReason ?? 'UNKNOWN_REVERT:none', sent.hash);
    }
    const hash = sent.hash as `0x${string}`;
    const receipt = await this.receiptOf(chainId, hash);
    this.logger.log(
      `${instruction} on ${chainId} in ${hash} — gasUsed ${receipt?.gasUsed ?? 'unknown'}`,
    );
    return { hash, receipt };
  }

  /**
   * The execution part of the estimate × 1.3 (capped at {@link EVM_SLASH_MAX_GAS})
   * plus the L1 part × 1.2. Refused, before anything is signed, when that limit
   * at the L2 basefee would cost more than
   * {@link EVM_SLASH_SEND_MAX_COST_WEI_PER_ITEM} per request, unless `urgent`.
   */
  private async gasFor(
    chainId: ChainId,
    to: `0x${string}`,
    data: `0x${string}`,
    send: { items: number; urgent: boolean; instruction: string },
  ): Promise<bigint> {
    const account = await this.relayerAddress(chainId);
    const estimate = await this.client(chainId).estimateGas({ account, to, data });
    const { l1Gas, l2BaseFee } = await estimateL1Gas(this.client(chainId), { account, to, data });
    // The reads are a moment apart: an L1 part at or above the whole estimate
    // leaves the split unknown, and the whole estimate is budgeted as execution.
    const split = estimate > l1Gas;
    const execution = split ? estimate - l1Gas : estimate;
    const executionLimit = (execution * GAS_HEADROOM_NUMERATOR) / GAS_HEADROOM_DENOMINATOR;
    if (executionLimit > EVM_SLASH_MAX_GAS) {
      throw ChainErrors.transactionFailed({
        reason: `estimated ${execution} gas of execution, above the ${EVM_SLASH_MAX_GAS} ceiling`,
        customErrorCode: null,
      });
    }
    const limit = executionLimit + (split ? paddedL1Gas(l1Gas) : 0n);
    const maxWei = EVM_SLASH_SEND_MAX_COST_WEI_PER_ITEM * BigInt(send.items);
    if (exceedsCostCap(limit, l2BaseFee, maxWei)) {
      if (send.urgent) {
        this.logger.warn(
          `${send.instruction} on ${chainId} is above the ${maxWei} wei cap (${limit} gas, ` +
            `L1 ${l1Gas}) but an execution in it is near its deadline: sending anyway`,
        );
        return limit;
      }
      // Unnamed, so the case is retried on a later tick: nothing was signed.
      throw ChainErrors.transactionFailed({
        instruction: send.instruction,
        reason:
          `${FEE_SPIKE_DEFERRED}: ${limit} gas (L1 ${l1Gas}) at ${l2BaseFee} wei is above the ` +
          `${maxWei} wei cap; nothing was sent`,
        customErrorCode: null,
      });
    }
    return limit;
  }

  /**
   * Whether a PENDING record's execution deadline (`executableAt` + the 7-day
   * grace, after which `expireSlash` may release it) is within
   * `EVM_FEE_CAP_WAIVED_WITHIN_SECONDS`.
   */
  private executionNearDeadline(record: EvmSlashRecord): boolean {
    if (slashStatusFromEvm(Number(record.status)) !== 'PENDING') return false;
    const nowSeconds = BigInt(Math.floor(this.config.now() / 1000));
    const deadline = BigInt(record.executableAt) + RECORD_EXECUTION_GRACE_SECONDS;
    return deadline - nowSeconds <= BigInt(EVM_FEE_CAP_WAIVED_WITHIN_SECONDS);
  }

  // ── Internals: attestations and records ─────────────────────────────────

  private async attest(request: SlashProposalRequest): Promise<{ callData: `0x${string}` }> {
    if (request.responseClass !== 'dataFail') {
      throw ChainErrors.payloadMalformed({ reason: 'only dataFail may slash' });
    }
    const chainId = request.chainId;
    const deployment = this.deployment(chainId);
    // Refused retryably: the case is proposed once the domains match.
    const domainRefusal = this.config.domains?.domainRefusal(chainId);
    if (domainRefusal) throw domainRefusal;
    await this.assertBeneficiaryIsAnAgent(request);
    await this.assertVerifierOutlivesRecord(chainId);
    const issuedAt = BigInt(Math.floor(this.config.now() / 1000)) - ATTESTATION_BACKDATE_SECONDS;
    const attestation: EvmSlashAttestation = {
      requestId: bytes32(request.requestId),
      provider: this.address(request.provider, 'provider'),
      beneficiary: this.address(request.beneficiary, 'beneficiary'),
      status: EVM_RESPONSE_CLASS_DATA_FAIL,
      penalty: parseMinorUnits(request.penaltyMinor),
      // The 32-byte policy field, as SHA-256 of the policy string — the same
      // mapping the Solana executor signs, so a dispute reads one convention.
      policy: sha256(toBytes(request.policy)),
      issuedAt,
      expiresAt: issuedAt + ATTESTATION_VALIDITY_SECONDS,
    };
    const digest = hashSlashAttestation(attestation, evmDomain(chainId, deployment.stake));

    const signed = await this.resolveSigner().sign({
      chainId,
      purpose: PROPOSE_ATTESTATION_PURPOSE,
      requestId: request.requestId,
      requestedBy: { type: SigningRequesterType.SERVICE, id: SUBMITTER_IDENTITY },
      payload: toBytes(digest),
    });
    if (signed.signature.length !== 65) {
      throw ChainErrors.payloadMalformed({
        reason: `a secp256k1 attestation signature is 65 bytes, got ${signed.signature.length}`,
      });
    }

    return {
      callData: encodeFunctionData({
        abi: ASSAY_STAKE_SLASH_ABI,
        functionName: 'proposeSlash',
        args: [attestation, toHex(signed.signature)],
      }),
    };
  }

  /**
   * Refuse to sign a record the verifier key would not live to execute
   * (review S-7): the key must outlive `now + slashDelaySeconds + the 30-day
   * dispute window + the 7-day execution grace`, read live. A dispute can
   * freeze the record up to 30 days before an uphold restarts the grace, and a
   * key that lapses meanwhile ends the record as `VerifierUnavailable` — read
   * as the provider's win. `executeSlash` re-checks the key. Refused
   * retryably: the case is proposed once a rotated key signs.
   */
  private async assertVerifierOutlivesRecord(chainId: ChainId): Promise<void> {
    const [verifier, delaySeconds] = await Promise.all([
      this.verifierAddress(chainId),
      this.slashDelaySeconds(chainId),
    ]);
    const key = (await this.client(chainId).readContract({
      address: this.deployment(chainId).config,
      abi: ASSAY_CONFIG_ABI,
      functionName: 'verifierKey',
      args: [verifier],
    })) as { expiresAt: bigint | number };
    const expiresAt = BigInt(key.expiresAt);
    const needed =
      BigInt(Math.floor(this.config.now() / 1000)) +
      BigInt(delaySeconds) +
      BigInt(EVM_CONSTANTS.DISPUTE_TIMEOUT_SECONDS) +
      RECORD_EXECUTION_GRACE_SECONDS;
    if (expiresAt > needed) return;
    throw ChainErrors.configValueInvalid({
      variable: `the on-chain expiry of verifier key ${verifier} on ${chainId}`,
      accepted:
        `later than ${new Date(Number(needed) * 1000).toISOString()} (now + the slash delay + ` +
        `the 30-day dispute window + the 7-day execution grace); rotate the key before proposing`,
    });
  }

  /**
   * Refuse, before anything is signed, a beneficiary that is not a harmed
   * agent: nobody (the contract refuses it anyway), a platform contract (an
   * ERC-20 transfer into the escrow, stake, config or multicall credits
   * nobody — the agent share would be burned), the treasury (it would take
   * 90% of the penalty), or the provider being judged (it would pay itself).
   */
  private async assertBeneficiaryIsAnAgent(request: SlashProposalRequest): Promise<void> {
    const beneficiary = this.address(request.beneficiary, 'beneficiary');
    const deployment = this.deployment(request.chainId);
    const params = await this.params(request.chainId);
    const forbidden = new Map<string, string>([
      ['0x0000000000000000000000000000000000000000', 'the zero address'],
      [getAddress(deployment.escrow), 'the escrow contract'],
      [getAddress(deployment.stake), 'the stake contract'],
      [getAddress(deployment.config), 'the config contract'],
      [getAddress(params.treasury), 'the treasury'],
      [this.address(request.provider, 'provider'), 'the provider being judged'],
    ]);
    const multicall = this.config.multicall.get(request.chainId);
    if (multicall) forbidden.set(getAddress(multicall), 'the multicall contract');
    const what = forbidden.get(beneficiary);
    if (what) {
      throw ChainErrors.payloadMalformed({
        reason: `refusing to sign a slash whose beneficiary is ${what} (${beneficiary})`,
      });
    }
  }

  private async adoptIfPresent(request: SlashProposalRequest): Promise<SlashProposalResult | null> {
    const record = await this.fetchRecord(request.chainId, request.requestId);
    if (!record) return null;
    this.assertRecordProvider(record, request.provider, request.requestId);
    // The same request id carrying a different judgement is not ours to
    // adopt. ONE rule, shared with the parts service: `slashRecordMismatch`.
    const mismatch = slashRecordMismatch(
      {
        beneficiary: record.beneficiary,
        penaltyMinor: record.penalty.toString(),
        policy: record.policy,
        verifierAccepted: (await this.verifierStanding(request.chainId, record.verifier))
          .verifierAccepted,
      },
      {
        beneficiary: this.address(request.beneficiary, 'beneficiary'),
        penaltyMinor: request.penaltyMinor,
        policy: request.policy,
      },
    );
    if (mismatch) {
      throw ChainErrors.payloadMalformed({
        reason: `slash record ${request.requestId} carries a different ${mismatch}; not adopting it`,
      });
    }
    const status = slashStatusFromEvm(Number(record.status));
    if (!status) return null;
    this.logger.warn(`proposeSlash ${request.requestId}: a ${status} record exists — adopting it`);
    return {
      signature: '',
      status,
      proposedAt: secondsToDate(record.proposedAt),
      executableAt: secondsToDate(record.executableAt),
      reservedMinor: record.reserved.toString(),
      adopted: true,
    };
  }

  private async proposalResultFromRecord(
    request: SlashProposalRequest,
    hash: `0x${string}`,
    adopted: boolean,
  ): Promise<SlashProposalResult> {
    const record = await this.fetchRecord(request.chainId, request.requestId);
    const status = record ? slashStatusFromEvm(Number(record.status)) : null;
    if (!record || !status) {
      throw ChainErrors.slashRecordNotFound({ requestId: request.requestId });
    }
    return {
      signature: hash,
      status,
      proposedAt: secondsToDate(record.proposedAt),
      executableAt: secondsToDate(record.executableAt),
      reservedMinor: record.reserved.toString(),
      adopted,
    };
  }

  /**
   * Refuse, before any gas, an execution whose record is absent or names a
   * different provider or beneficiary than the case does — `beneficiary` is
   * passed precisely so it cannot be substituted.
   */
  private async assertExecutable(request: SlashExecutionRequest): Promise<EvmSlashRecord> {
    const record = await this.fetchRecord(request.chainId, request.requestId);
    if (!record) throw ChainErrors.slashRecordNotFound({ requestId: request.requestId });
    this.assertRecordProvider(record, request.provider, request.requestId);
    if (getAddress(record.beneficiary) !== this.address(request.beneficiary, 'beneficiary')) {
      throw ChainErrors.payloadMalformed({
        reason: `slash record ${request.requestId} pays a different beneficiary than the case`,
      });
    }
    return record;
  }

  private executeCallData(requestId: string): `0x${string}` {
    return encodeFunctionData({
      abi: ASSAY_STAKE_SLASH_ABI,
      functionName: 'executeSlash',
      args: [bytes32(requestId)],
    });
  }

  private async executionResultFromReceipt(
    request: SlashExecutionRequest,
    receipt: Awaited<ReturnType<EvmSlashClient['getTransactionReceipt']>>,
    hash: `0x${string}`,
  ): Promise<SlashExecutionResult | null> {
    const event = findEvent(
      receipt,
      this.deployment(request.chainId).stake,
      'SlashExecuted',
      request.requestId,
    );
    if (!event) return null;
    const args = event.args as {
      applied: bigint;
      agentAmount: bigint;
      platformAmount: bigint;
      executedAt: bigint;
    };
    // All or wait: an execution pays exactly the record's `reserved`. Read
    // back and compared, never assumed; a mismatch is logged, and the event's
    // `applied` is still what is recorded, since it is what moved.
    try {
      const record = await this.fetchRecord(request.chainId, request.requestId);
      if (record && BigInt(record.reserved) !== BigInt(args.applied)) {
        this.logger.error(
          `executeSlash ${request.requestId} on ${request.chainId} applied ${args.applied}, but ` +
            `the record reserved ${record.reserved}; the contract pays all or waits`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `executeSlash ${request.requestId}: the record could not be read back to check the ` +
          `applied amount (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return {
      signature: hash,
      appliedMinor: BigInt(args.applied).toString(),
      agentAmountMinor: BigInt(args.agentAmount).toString(),
      platformAmountMinor: BigInt(args.platformAmount).toString(),
      executedAt: secondsToDate(BigInt(args.executedAt)),
    };
  }

  private async fetchRecord(
    chainId: ChainId,
    requestId: string,
    blockTag?: 'finalized',
  ): Promise<EvmSlashRecord | null> {
    const record = await readSlashRecord(
      this.client(chainId),
      this.deployment(chainId).stake,
      bytes32(requestId),
      blockTag,
    );
    // `None` (0) is the untouched mapping slot: no record.
    return record.status === 0 ? null : record;
  }

  private assertRecordProvider(record: EvmSlashRecord, provider: string, requestId: string): void {
    if (getAddress(record.provider) !== this.address(provider, 'provider')) {
      throw ChainErrors.payloadMalformed({
        reason: `slash record ${requestId} belongs to a different provider`,
      });
    }
  }

  private async params(chainId: ChainId) {
    return (await this.client(chainId).readContract({
      address: this.deployment(chainId).config,
      abi: ASSAY_CONFIG_ABI,
      functionName: 'params',
      args: [],
    })) as {
      treasury: `0x${string}`;
      penaltyAmount: bigint;
      verifierDailyCap: bigint;
      slashAgentBps: number;
      slashPlatformBps: number;
      slashCapBps: number;
    };
  }

  /** The address of the key this platform signs with on `chainId`. */
  private async verifierAddress(chainId: ChainId): Promise<`0x${string}`> {
    const publicKey = await this.resolveSigner().publicKey(chainId);
    return getAddress(publicKeyToAddress(toHex(publicKey)));
  }

  private resolveSigner(): EvmAttestationSigner {
    try {
      return this.signers.get(this.signerToken, { strict: false }) as EvmAttestationSigner;
    } catch (cause) {
      throw ChainErrors.programNotConfigured({
        what:
          'a verifier signing capability in this process — VerifierSigningModule is not ' +
          'imported here' +
          (cause instanceof Error ? ` (${cause.message})` : ''),
      });
    }
  }

  private async relayerAddress(chainId: ChainId): Promise<`0x${string}`> {
    return parseAccountId(await this.relayer.address(chainId)).address as `0x${string}`;
  }

  private address(value: string, field: string): `0x${string}` {
    if (!isAddress(value, { strict: false })) {
      throw ChainErrors.payloadMalformed({ reason: `${field} is not an EVM address: ${value}` });
    }
    return getAddress(value);
  }

  private deployment(chainId: ChainId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) throw ChainErrors.unsupportedChain({ chainId });
    return deployment;
  }

  private client(chainId: ChainId): EvmSlashClient {
    const client = this.clients.get(chainId);
    if (!client) throw ChainErrors.unsupportedChain({ chainId });
    return client;
  }
}

function aggregate3(stake: `0x${string}`, rows: readonly { callData: `0x${string}` }[]) {
  return encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3',
    args: [rows.map((row) => ({ target: stake, allowFailure: true, callData: row.callData }))],
  });
}

type Receipt = Awaited<ReturnType<EvmSlashClient['getTransactionReceipt']>>;

/** The first `eventName` the stake contract emitted for `requestId` in `receipt`. */
function findEvent(
  receipt: Receipt,
  stake: `0x${string}`,
  eventName: 'SlashProposed' | 'SlashExecuted' | 'SlashCancelled',
  requestId: string,
): { eventName: string; args: Record<string, unknown> } | null {
  const wanted = bytes32(requestId);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== stake.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: ASSAY_STAKE_SLASH_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      }) as unknown as { eventName: string; args: Record<string, unknown> };
      if (
        decoded.eventName === eventName &&
        (decoded.args as { requestId: string }).requestId.toLowerCase() === wanted
      ) {
        return decoded;
      }
    } catch {
      // Not one of ours (a token Transfer from the same batch).
    }
  }
  return null;
}

function refusal(
  requestId: string,
  reason: SlashIdRefusal['reason'],
  detail: string,
): SlashIdRefusal {
  return { requestId: requestId.replace(/^0x/, '').toLowerCase(), reason, detail };
}

function revertError(instruction: string, name: string, hash: string | null) {
  return ChainErrors.transactionFailed({
    instruction,
    ...(hash ? { signature: hash } : {}),
    reason: name,
    customErrorCode: null,
    programErrorName: name,
  });
}

function bytes32(requestId: string): `0x${string}` {
  const hex = requestId.startsWith('0x') ? requestId.slice(2) : requestId;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw ChainErrors.payloadMalformed({
      reason: `requestId is not 32 bytes of hex: ${requestId}`,
    });
  }
  return `0x${hex.toLowerCase()}`;
}

function parseMinorUnits(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw ChainErrors.payloadMalformed({
      reason: `penalty is not a non-negative integer: ${value}`,
    });
  }
  const amount = BigInt(value);
  if (amount <= 0n || amount > 0xffff_ffff_ffff_ffffn) {
    throw ChainErrors.payloadMalformed({ reason: `penalty ${value} is outside (0, uint64]` });
  }
  return amount;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function secondsToDate(seconds: bigint): Date {
  return new Date(Number(seconds) * 1000);
}
