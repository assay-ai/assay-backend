import { Inject, Injectable, Logger } from '@nestjs/common';
import { decodeEventLog, encodeFunctionData, getAddress, isAddress, zeroAddress } from 'viem';

import {
  FEE_SPIKE_DEFERRED,
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
  UsedSeqRecord,
  VoucherRedeemerPort,
} from '@modules/payment/ports/voucher-redeemer.port';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { AccountId, ChainId, parseAccountId, toAccountId } from '../ports/caip.types';
import {
  ASSAY_CONFIG_ABI,
  ASSAY_ESCROW_ABI,
  ASSAY_STAKE_ABI,
  MULTICALL3_CLOCK_ABI,
} from './abi/assay.abi';
import { ASSAY_ESCROW_HOLD_ABI } from './abi/assay-hold.abi';
import { EvmVoucher } from './eip712/voucher';
import { EVM_CONSTANTS, EvmDeployment, MULTICALL3_ADDRESS } from './evm.constants';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';
import {
  EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM,
  estimateL1Gas,
  exceedsCostCap,
  EVM_FEE_CAP_WAIVED_WITHIN_SECONDS,
  paddedL1Gas,
} from './evm-l1-gas';
import {
  freeBondedStake,
  PrevalidationDelegation,
  PrevalidationState,
  prevalidateBatch,
  prevalidateVoucher,
} from './evm-voucher-prevalidation';
import { isRevert } from './evm-voucher-authority';
import { evmErrorName, revertDataOf } from './abi/error-selectors';
import { EVM_REDEEMER, EvmRelayerPort } from './ports/evm-relayer.port';
import { EvmSendBudget, EvmSendFloat } from './evm-send-float';
import {
  EvmSendRejectedError,
  isInsufficientFunds,
  isSendRejected,
} from './evm-send-rejected.error';
import { EvmTightenDelayProbe } from './evm-tighten-delay.probe';
import { slashStatusFromEvm } from './evm-slash-status';

/** The read the redeemer needs from `evm_slash_records` (review 2026-10-24 wave 2 M-2). */
export interface UnplannedSlashRecords {
  standingNotPlanned(
    chainId: string,
    provider: string,
  ): Promise<readonly { requestId: string; reserved: bigint }[]>;
}

/** How long one provider's "short only by unplanned slashes" answer is reused. */
const UNPLANNED_SLASH_ANSWER_TTL_MS = 30_000;

/**
 * The gas a redemption transaction is given, as `base + perVoucher × n`.
 *
 * Measured, from assay-evm's `docs/gas.md`: `redeemVoucher` is **170 452**; a uniform
 * batch of 64 is **1 623 055**; the worst measured batch of 64 — distinct payers
 * *and* distinct providers, which is the shape this class deliberately produces
 * — is **5 235 730**. The budget below is 320 000 at n = 1 (1.9×) and 7 880 000
 * at n = 64 (1.5× the worst measurement, and 24.6 % of the
 * `maxTxGasLimit = 32 000 000` that `ArbGasInfo.getGasAccountingParams()`
 * reports on both 4663 and 46630).
 *
 * It is a **budget, not an estimate**, and `EvmRelayerPort.sendCall` takes it
 * rather than estimating: `eth_estimateGas` on a batch that is about to revert
 * returns nothing useful, and a relayer that estimated would turn "this
 * redemption is invalid" into "the RPC said no" at a point where the caller can
 * no longer tell the two apart.
 *
 * Every figure was taken against `MockUSDG`, roughly the cheapest possible
 * ERC-20. Real USDG is an upgradeable proxy with a blocklist and a
 * redemption performs two transfers, which is what the margin above is for;
 * it has not yet been re-measured against the real token on 46630.
 *
 * This is the **execution** budget. On a Nitro chain the limit sent also carries
 * the L1 posting cost in L2 gas, read per send and padded 20 % (`evm-l1-gas.ts`);
 * a send whose whole limit would cost more than
 * `EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM` per voucher is not sent, and every
 * voucher it carries is a `RETRY` with `programError = FeeSpikeDeferred`.
 */
export const EVM_REDEEM_BATCH_BASE_GAS = 200_000n;
export const EVM_REDEEM_PER_VOUCHER_GAS = 120_000n;

/** A send deferred by {@link FEE_SPIKE_DEFERRED}: nothing signed, nothing broadcast. */
const FEE_SPIKE_DEFERRED_OUTCOME: RedeemOutcome = {
  kind: RedeemOutcomeKind.RETRY,
  signature: null,
  programError: FEE_SPIKE_DEFERRED,
};

/** The fixed tag on the log line of a redemption the redeemer's float cannot pay. */
export const EVM_REDEEMER_FLOAT_SHORT_LOG_TAG = '[redeemer-float-short]';

/** The alert a refusal nobody can name raises. */
export const EVM_REDEEM_UNKNOWN_REVERT_ALERT = 'evm_redeem_unknown_revert';

/** The alert raised when the chain's clock and this process's disagree by more than {@link EVM_CLOCK_DRIFT_WARN_SECONDS}. */
export const EVM_CLOCK_DRIFT_ALERT = 'evm_chain_clock_drift';

/**
 * How far `block.timestamp` may sit from this process's wall clock before it
 * is reported (review 2026-10-23 L-4): a sequencer whose clock runs away moves
 * every voucher's deadline, withdrawal and revocation with it.
 */
export const EVM_CLOCK_DRIFT_WARN_SECONDS = 120;

/**
 * The fixed tag on the log line of an expiry decision held because the chain's
 * clock ran ahead of this process's by more than
 * {@link EVM_CLOCK_DRIFT_WARN_SECONDS}: what a log-based counter or a later
 * alert keys on.
 */
export const EVM_EXPIRY_HELD_LOG_TAG = 'evm_voucher_expiry_held_chain_clock_ahead';

export interface EvmVoucherRedeemerConfig {
  /** Milliseconds, `Date.now()`'s own unit. The chain's timestamps are seconds. */
  readonly now: () => number;
}

/**
 * Refusals about the **deployment**, not about the voucher.
 *
 * Every hold on the platform is refused identically until a human acts, so
 * `RETRY` would burn a fee per hold per pass for ever and `UNREDEEMABLE` would
 * turn every served call into buyer debt for a fault one `updateConfig` fixes.
 *
 * The three batch-shape errors are here because they are this job's own bugs
 * rather than a chain condition, and because a table that omits an error cannot
 * report it if it ever fires. They are all guarded before a send, so the entries
 * should be unreachable; "cannot happen" is a claim about today's code.
 */
const MISCONFIGURATION: ReadonlySet<string> = new Set([
  'NotRedeemer',
  'MissingRedeemer',
  'AssetDecimalsNotSix',
  'EmptyBatch',
  'BatchTooLarge',
  'BatchLengthMismatch',
]);

/**
 * Terminal. Nothing about a later attempt changes any of them.
 *
 * The window and sequence refusals are facts about a voucher that is already
 * signed, and the four signature refusals are facts about bytes that are already
 * fixed. When one comes back the call becomes buyer debt: the buyer's hold is
 * released, the provider is not credited, and the platform pays nothing.
 */
const UNREDEEMABLE: ReadonlySet<string> = new Set([
  'ZeroAmount',
  'InvalidVoucherWindow',
  'VoucherLifetimeTooLong',
  'VoucherExpired',
  'VoucherSeqZero',
  // D-23: this (payer, seq) was already redeemed — held, collected or
  // refunded — and records are never deleted. Also what a voucher that ALREADY
  // landed gets, which is why the job looks for its own landing before it
  // closes anything (`findLanding`).
  'VoucherSeqUsed',
  // The seq is more than MAX_SEQ_GAP above the payer's seqHigh. Admission
  // refuses such a voucher against a seqHigh that only grows afterwards, so a
  // served voucher should never meet it.
  'VoucherSeqGapTooLarge',
  'SignerIsNotPayer',
  'InvalidSignature',
  'MalleableSignature',
  'BadSignatureV',
]);

/**
 * All of these can become true: a buyer funds their escrow, the window decays,
 * a buyer raises their own ceiling, a provider tops their stake back up, and a
 * voucher issued ahead of our clock becomes valid by waiting.
 */
const RETRYABLE: ReadonlySet<string> = new Set([
  'EscrowInsufficient',
  'EscrowWindowLimitExceeded',
  'VoucherExceedsPerCallLimit',
  'ProviderBelowMinimumStake',
  'VoucherNotYetValid',
  // A delegate's window decays. Pre-validation and the simulation before every
  // send keep the retry from costing gas: nothing is broadcast until it fits.
  'DelegateWindowLimitExceeded',
  // Agent payment delegation, tightened by the payer. A re-grant or a raised
  // cap before the voucher's deadline makes the SAME signed voucher valid
  // again, so these are retried until then rather than turned into buyer
  // debt at once (review-buyer-debt M3). Pre-validation refuses them before
  // any send, so the retries cost no gas. On an escrow with the tighten delay
  // (D-21) a voucher signed before the tightening is not refused at all for
  // TIGHTEN_DELAY_SECONDS, which outlives its deadline; these then fire only
  // for a voucher admitted against a stale read, under the same rule.
  'DelegateIsRevoked',
  'DelegateIsExpired',
  'DelegateVoucherExceedsPerCallLimit',
]);

/** `r || s || v`, 65 bytes. */
const SECP256K1_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/**
 * This codebase's prefix on a stored hash; the contract signs 32 raw bytes.
 *
 * Both hash columns carry it: `payment_intents.request_hash` holds
 * `computeRequestHash`'s `sha256:<64 hex>` verbatim, and it is what
 * `VoucherRedemptionService` replays here. The prefix names the platform's
 * encoding, not the digest function — on eip155 the resource hash under it is
 * keccak, because that is what the voucher signed.
 */
const HASH_PREFIX = 'sha256:';

/**
 * `VoucherRedeemerPort` on `eip155` — **pre-validate the batch, and retry
 * singly**.
 *
 * `redeemVoucherBatch` is atomic by decision, not by oversight:
 * skip-and-continue would need a per-item external self-call, would leave an
 * event stream that no longer says which vouchers settled, and would let one
 * malformed item quietly drop 63 good ones into a state nobody reconciles. The
 * cost of that decision lands here, and assay-evm's `docs/gas.md` states
 * both halves in the imperative.
 *
 * ## The three batch rules, and the one arrangement that satisfies them at once
 *
 * assay-evm's `docs/gas.md` names three rules a job that does not know them will break:
 *
 *  1. **`seq` is per payer, not per batch.** Two payers' sequences constrain
 *     each other in no way, and since D-23 one payer's items may come in any
 *     order: each `(payer, seq)` is redeemed once, a lower seq after a higher
 *     one included.
 *  2. **The same voucher twice in one batch reverts the batch** — the second
 *     copy fails `VoucherSeqUsed`, because the first already used the seq.
 *  3. **The parameter set is read once for the whole batch**: every item settles
 *     against the treasury and take rate current when the batch started, even if
 *     a `Config` update lands mid transaction.
 *
 * Rule 2 is asserted rather than assumed: a batch carrying one `(payer, seq)`
 * twice is refused before anything is read. Several vouchers of one payer may
 * share a batch, and pre-validation applies each one's effects to the next
 * ({@link prevalidateBatch}) the way `_redeem` does, so the payer's balance,
 * window and used seqs are what the chain will see at that item.
 *
 * Because no order is required, a voucher that does not land never holds back
 * the same payer's later ones ({@link requiresAscendingSeq} is `false`).
 *
 * ## Why a revert cannot say which item did it
 *
 * A revert is a bare 4-byte selector — every one of `Errors.sol`'s errors is
 * zero-argument — with no index in it. So when a batch reverts, the only thing
 * that makes progress is one transaction each. Re-submitting the batch would
 * fail identically, for ever.
 */
@Injectable()
export class EvmVoucherRedeemer implements VoucherRedeemerPort {
  private readonly logger = new Logger(EvmVoucherRedeemer.name);

  /** `Constants.MAX_REDEEM_BATCH`. `redeemVoucherBatch` refuses more. */
  readonly maxBatchSize = EVM_CONSTANTS.MAX_REDEEM_BATCH;

  /**
   * `false`: `AssayEscrow` admits each `(payer, seq)` once, in any order
   * (D-23), so a lower seq landing after a higher one is still paid and a
   * voucher being retried never needs to hold back the payer's later ones.
   */
  requiresAscendingSeq(): boolean {
    return false;
  }

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmReaderClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    /**
     * The REDEEMER key's sender — `Config.params().redeemer` — and never the
     * relayer that carries buyer-signed requests. Distinct keys (checked at
     * boot), so a leaked relayer key cannot redeem and a leaked redeemer key
     * cannot spend the gas-grant float.
     */
    @Inject(EVM_REDEEMER) private readonly redeemer: EvmRelayerPort,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    private readonly config: EvmVoucherRedeemerConfig,
    /**
     * Whether the chain's escrow has the tighten delay (D-21). Absent, every
     * chain is read the pre-upgrade way: stored caps, a revocation final at once.
     */
    private readonly tightenDelay: Pick<EvmTightenDelayProbe, 'isLive'> | null = null,
    /**
     * The slash records the watcher saw. Absent, every `ProviderBelowMinimumStake`
     * is the provider's own (the behaviour before review 2026-10-24 wave 2 M-2).
     */
    private readonly slashRecords: UnplannedSlashRecords | null = null,
    /**
     * The redeemer's float, read before a send so the send is sized to it.
     * Absent, sends are not sized (the relayer's own pre-send check remains).
     */
    private readonly float: EvmSendFloat | null = null,
  ) {}

  private readonly unplannedAnswers = new Map<string, { at: number; short: boolean }>();

  async redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome> {
    const chainId = this.chainOf(request);
    const voucher = this.toVoucher(request);
    const [state] = await this.readState(chainId, [request]);

    // Pre-validated on the single path too. A retry after a batch revert reads
    // state that may have moved since the batch was assembled, and a hold whose
    // refusal is now different has to be reported as what it is now.
    const refusal = prevalidateVoucher(voucher, state);
    if (refusal !== null) {
      return this.decided(chainId, refusal, voucher, state);
    }

    // Simulated with the redeemer as sender and the gas it will be sent with,
    // so a refusal pre-validation cannot see — the signature, a wallet's answer —
    // costs an `eth_call` and never a mined revert (review S2-2).
    const args = [voucher, this.signatureOf(request)] as const;
    const data = encodeFunctionData({ abi: ASSAY_ESCROW_ABI, functionName: 'redeemVoucher', args });
    const gasLimit = await this.gasLimit(
      chainId,
      data,
      1,
      nearDeadline([voucher], state.nowSeconds),
    );
    if (gasLimit === null) return FEE_SPIKE_DEFERRED_OUTCOME;
    const budget = await this.float?.budget(chainId, nearDeadline([voucher], state.nowSeconds));
    if (budget && fitCount(1, gasLimit, budget) === 0) {
      throw this.floatTooLow(chainId, 1, gasLimit, budget);
    }
    const simulated = await this.simulate(chainId, 'redeemVoucher', args, gasLimit);
    if (simulated !== null) {
      return this.decided(chainId, simulated, voucher, state);
    }

    const result = await this.sendTracked(chainId, gasLimit, budget ?? null, {
      chainId,
      to: this.escrowAccount(chainId),
      data,
      gasLimit,
      purpose: `redeemVoucher seq=${request.seq}`,
      beforeBroadcast: async (hash) => {
        await request.recordAttempt?.(hash);
      },
    });

    if (result.status === 'SUCCESS') {
      return { kind: RedeemOutcomeKind.REDEEMED, signature: result.hash, programError: null };
    }
    return this.decided(chainId, result.revertReason, voucher, state);
  }

  /**
   * The provider's FREE bonded stake (`bonded − pendingSlash`, D-26) against
   * `params().minimumStake`, read live in the same multicall the pre-validator
   * uses, so the two cannot disagree on what "below the minimum" means.
   */
  async providerBelowMinimumStake(request: RedeemVoucherRequest): Promise<boolean> {
    const [state] = await this.readState(this.chainOf(request), [request]);
    return state.providerFreeBonded < state.minimumStake;
  }

  /**
   * Whether the provider is below the minimum FREE stake only because of
   * standing records it did not cause — foreign to this platform, or signed by
   * a verifier key that can no longer sign (review 2026-10-24 wave 2 M-2).
   *
   * Reads `stakeOf`, `params().minimumStake` and each such record's
   * `slashRecordOf` live in one multicall; only records still `Pending` or
   * `Disputed` against this provider count, at their on-chain `reserved`.
   * `true` iff `bonded − pendingSlash < minimum` AND
   * `bonded − (pendingSlash − unplanned) ≥ minimum`. A provider with no such
   * record costs no RPC call. One answer per provider is reused for 30 s.
   */
  async providerShortOnlyByUnplannedSlashes(request: RedeemVoucherRequest): Promise<boolean> {
    if (!this.slashRecords) return false;
    const chainId = this.chainOf(request);
    const provider = this.addressOf(request.provider, chainId);
    const key = `${chainId}:${provider}`;
    const cached = this.unplannedAnswers.get(key);
    const now = this.config.now();
    if (cached && now - cached.at < UNPLANNED_SLASH_ANSWER_TTL_MS) return cached.short;

    const records = await this.slashRecords.standingNotPlanned(chainId, provider.toLowerCase());
    let short = false;
    if (records.length > 0) {
      const deployment = this.deployment(chainId);
      const results = await this.client(chainId).multicall({
        contracts: [
          {
            address: getAddress(deployment.config),
            abi: ASSAY_CONFIG_ABI,
            functionName: 'params',
            args: [],
          },
          {
            address: getAddress(deployment.stake),
            abi: ASSAY_STAKE_ABI,
            functionName: 'stakeOf',
            args: [provider] as readonly unknown[],
          },
          ...records.map((record) => ({
            address: getAddress(deployment.stake),
            abi: ASSAY_STAKE_ABI,
            functionName: 'slashRecordOf',
            args: [`0x${record.requestId}`] as readonly unknown[],
          })),
        ],
        allowFailure: false,
      });
      const minimum = BigInt((results[0] as { minimumStake: bigint }).minimumStake);
      const stake = results[1] as { bonded: bigint; pendingSlash: bigint };
      const bonded = BigInt(stake.bonded);
      const pending = BigInt(stake.pendingSlash);
      let unplanned = 0n;
      for (const raw of results.slice(2) as {
        provider: string;
        status: number | bigint;
        reserved: bigint;
      }[]) {
        const status = slashStatusFromEvm(Number(raw.status));
        if (status !== 'PENDING' && status !== 'DISPUTED') continue;
        if (getAddress(raw.provider) !== provider) continue;
        unplanned += BigInt(raw.reserved);
      }
      const free = freeBondedStake({ bonded, pendingSlash: pending });
      const freeWithout = freeBondedStake({
        bonded,
        pendingSlash: pending > unplanned ? pending - unplanned : 0n,
      });
      short = free < minimum && freeWithout >= minimum;
    }
    this.unplannedAnswers.set(key, { at: now, short });
    return short;
  }

  /**
   * `held(payer, seq)` against this voucher: whether the record that makes the
   * seq used names this voucher's provider and amount (D-23), and if so its
   * status — `Held`, `Collected` or `Refunded` (review 2026-10-24 F-L3). Asked
   * after a `VoucherSeqUsed` that none of the intent's own transactions
   * explains.
   */
  async usedSeqRecord(request: RedeemVoucherRequest): Promise<UsedSeqRecord> {
    const chainId = this.chainOf(request);
    const voucher = this.toVoucher(request);
    const record = (await this.client(chainId).readContract({
      address: getAddress(this.deployment(chainId).escrow),
      abi: ASSAY_ESCROW_HOLD_ABI,
      functionName: 'held',
      args: [voucher.payer, voucher.seq],
    })) as { provider: string; amount: bigint; status: number | bigint };
    // `HeldStatus`: 0 None (the seq is unused), 1 Held, 2 Collected, 3 Refunded.
    const status = Number(record.status);
    if (status === 0) return 'NONE';
    if (
      getAddress(record.provider) !== voucher.provider ||
      BigInt(record.amount) !== voucher.amount
    ) {
      return 'MISMATCH';
    }
    if (status === 1) return 'HELD';
    if (status === 2) return 'COLLECTED';
    if (status === 3) return 'REFUNDED';
    // Unknown to this build: "cannot tell", so the hold waits for a human.
    throw new Error(`held(payer, seq) answered HeldStatus ${status}, which has no meaning here`);
  }

  async redeemBatch(requests: readonly RedeemVoucherRequest[]): Promise<readonly RedeemOutcome[]> {
    if (requests.length === 0) {
      return [];
    }
    this.assertNoDuplicateVoucher(requests);
    if (requests.length > EVM_CONSTANTS.MAX_REDEEM_BATCH) {
      throw ChainErrors.payloadMalformed({
        reason: `a redemption batch of ${requests.length} exceeds MAX_REDEEM_BATCH (64)`,
      });
    }

    const chainId = this.oneChain(requests);
    const vouchers = requests.map((request) => this.toVoucher(request));
    const signatures = requests.map((request) => this.signatureOf(request));
    const states = await this.readState(chainId, requests);
    // Item by item, each seeing the effects of the earlier items of its payer
    // that would settle — what `redeemVoucherBatch` itself does.
    const refusals = prevalidateBatch(
      vouchers.map((voucher, index) => ({
        voucher,
        state: states[index],
        delegate: requests[index].delegate ?? null,
      })),
    );

    // The batch is only the ones that would settle. Submitting a known-bad item
    // is submitting a transaction we already know reverts, and it takes 63 good
    // ones with it.
    const admissible = requests
      .map((_, index) => index)
      .filter((index) => refusals[index] === null);
    if (admissible.length === 0) {
      return refusals.map((name, i) => this.decided(chainId, name, vouchers[i], states[i]));
    }

    // Every refused item is decided now; every admissible one is filled in by
    // its group below, or left EMPTY when the float could not pay for it. An
    // empty slot means "not attempted": `VoucherRedemptionService` blocks that
    // payer for the pass and assumes nothing.
    const outcomes: (RedeemOutcome | undefined)[] = refusals.map((name, i) =>
      name === null ? undefined : this.decided(chainId, name, vouchers[i], states[i]),
    );

    // URGENT items (a voucher within EVM_FEE_CAP_WAIVED_WITHIN_SECONDS of its
    // deadline) go first, as their own batch: their waiver of the fee cap and
    // of the float reserve must not carry the rest of the batch with it, and
    // when the float is short they are the ones it pays for.
    const urgent = admissible.filter((i) => nearDeadline([vouchers[i]], states[i].nowSeconds));
    const ordinary = admissible.filter((i) => !urgent.includes(i));
    const groups = [
      { indexes: urgent, urgent: true },
      { indexes: ordinary, urgent: false },
    ].filter((group) => group.indexes.length > 0);

    const batch: BatchContext = { chainId, requests, vouchers, signatures, outcomes, admissible };
    for (const group of groups) {
      const more = await this.redeemGroup(batch, group.indexes, group.urgent);
      if (!more) break;
    }
    return outcomes as RedeemOutcome[];
  }

  /**
   * One redemption transaction for `indexes` (all urgent, or none), cut to what
   * the float can pay. Fills `batch.outcomes` for what it attempted. Returns
   * `false` when the float is spent, so no further group is tried.
   *
   * When the float cannot pay for even one item and nothing in this call has
   * an outcome yet, it throws `EvmSendRejectedError` (`INSUFFICIENT_FUNDS`, no
   * hash): nothing was signed or broadcast, and the redemption pass reads that
   * as the end of the pass. Once an earlier group has outcomes, the rest is
   * left empty instead, so those outcomes are not lost to a throw.
   */
  private async redeemGroup(
    batch: BatchContext,
    group: readonly number[],
    urgent: boolean,
  ): Promise<boolean> {
    const { chainId, requests, vouchers, signatures, outcomes } = batch;
    let indexes = group;
    let { data, args } = this.batchCall(vouchers, signatures, indexes);
    let gasLimit = await this.gasLimit(chainId, data, indexes.length, urgent);
    if (gasLimit === null) {
      // Not sent, and not split: singles would meet the same fees. Every
      // admissible item waits for the next pass; the rest are what they are.
      for (const index of indexes) outcomes[index] = FEE_SPIKE_DEFERRED_OUTCOME;
      return true;
    }

    // SIZED TO THE FLOAT. The node refuses a send whose gasLimit × maxFeePerGas
    // is above the balance, so a batch the float cannot pay is cut here, before
    // anything is signed, rather than refused after its hash was recorded.
    const budget = (await this.float?.budget(chainId, urgent)) ?? null;
    if (budget) {
      const fit = fitCount(indexes.length, gasLimit, budget);
      if (fit < indexes.length) {
        if (fit === 0) {
          const error = this.floatTooLow(chainId, indexes.length, gasLimit, budget);
          if (!this.anyAttempted(batch)) throw error;
          return false;
        }
        this.logger.warn(
          `The redeemer float on ${chainId} pays ${fit} of ${indexes.length} redemptions ` +
            `(${budget.spendableWei} wei spendable over a ${budget.reserveWei} wei reserve); ` +
            `the other ${indexes.length - fit} wait for a top-up`,
        );
        indexes = indexes.slice(0, fit);
        ({ data, args } = this.batchCall(vouchers, signatures, indexes));
        gasLimit = await this.gasLimit(chainId, data, indexes.length, urgent);
        if (gasLimit === null) {
          for (const index of indexes) outcomes[index] = FEE_SPIKE_DEFERRED_OUTCOME;
          return false;
        }
      }
    }

    // SIMULATE the batch first, with the gas it will be sent with. A batch the
    // chain would refuse is never broadcast: it goes straight to the singles,
    // each of which simulates again (review S2-2).
    const simulated = await this.simulate(chainId, 'redeemVoucherBatch', args, gasLimit);
    if (simulated !== null) {
      this.logger.warn(
        `A redemption batch of ${indexes.length} would revert with ${simulated}; ` +
          `nothing was broadcast — redeeming the items singly`,
      );
      return this.redeemSingles(batch, indexes);
    }

    let result: Awaited<ReturnType<EvmRelayerPort['sendCall']>>;
    try {
      result = await this.sendTracked(chainId, gasLimit, budget, {
        chainId,
        to: this.escrowAccount(chainId),
        data,
        gasLimit,
        purpose: `redeemVoucherBatch n=${indexes.length}`,
        // One hash, recorded on every voucher it carries.
        beforeBroadcast: async (hash) => {
          for (const index of indexes) {
            await requests[index].recordAttempt?.(hash);
          }
        },
      });
    } catch (error) {
      // The node refused it: not broadcast. With earlier outcomes in hand the
      // rest is left empty rather than thrown away with them.
      if (isSendRejected(error) && this.anyAttempted(batch)) {
        return !isInsufficientFunds(error);
      }
      throw error;
    }

    if (result.status === 'SUCCESS') {
      for (const index of indexes) {
        outcomes[index] = {
          kind: RedeemOutcomeKind.REDEEMED,
          signature: result.hash,
          programError: null,
        };
      }
      return true;
    }

    // RETRY SINGLY. The batch reverted, so we do not know WHICH item did it:
    // pre-validation reads state that may have moved between the read and the
    // send, and a revert is a 4-byte selector with no index. Re-submitting the
    // batch would fail identically, for ever. One transaction each is slower and
    // it is the only thing that makes progress.
    this.logger.warn(
      `A redemption batch of ${indexes.length} reverted with ` +
        `${result.revertReason ?? 'an unreadable reason'}; retrying the items singly`,
    );
    return this.redeemSingles(batch, indexes);
  }

  /**
   * Each of `indexes` on its own. A single the node refused was not broadcast
   * and is left empty; one refused for funds ends the run (every later one
   * would be refused the same way) and returns `false`. Any other throw is
   * rethrown, as it always was.
   */
  private async redeemSingles(batch: BatchContext, indexes: readonly number[]): Promise<boolean> {
    for (const index of indexes) {
      try {
        batch.outcomes[index] = await this.redeem(batch.requests[index]);
      } catch (error) {
        if (!isSendRejected(error)) throw error;
        if (isInsufficientFunds(error)) {
          if (!this.anyAttempted(batch)) throw error;
          return false;
        }
      }
    }
    return true;
  }

  /** `redeemVoucherBatch` for `indexes`: its calldata and its arguments. */
  private batchCall(
    vouchers: readonly EvmVoucher[],
    signatures: readonly `0x${string}`[],
    indexes: readonly number[],
  ): { data: `0x${string}`; args: readonly unknown[] } {
    const args = [indexes.map((i) => vouchers[i]), indexes.map((i) => signatures[i])] as const;
    return {
      data: encodeFunctionData({ abi: ASSAY_ESCROW_ABI, functionName: 'redeemVoucherBatch', args }),
      args,
    };
  }

  /** Whether an admissible item of this call already has an outcome (deferred, sent or single). */
  private anyAttempted(batch: BatchContext): boolean {
    return batch.admissible.some((index) => batch.outcomes[index] !== undefined);
  }

  /**
   * `sendCall`, keeping the float's books: the worst cost comes off the cached
   * balance after a send, and a refusal for funds empties it.
   */
  private async sendTracked(
    chainId: ChainId,
    gasLimit: bigint,
    budget: EvmSendBudget | null,
    call: Parameters<EvmRelayerPort['sendCall']>[0],
  ): Promise<Awaited<ReturnType<EvmRelayerPort['sendCall']>>> {
    try {
      const result = await this.redeemer.sendCall(call);
      if (budget) this.float?.spent(chainId, gasLimit * budget.maxFeePerGas);
      return result;
    } catch (error) {
      if (isInsufficientFunds(error)) this.float?.drained(chainId);
      throw error;
    }
  }

  /** The refusal, and its log line, for a float that cannot pay one redemption. */
  private floatTooLow(
    chainId: ChainId,
    items: number,
    gasLimit: bigint,
    budget: EvmSendBudget,
  ): EvmSendRejectedError {
    const detail =
      `the redeemer float on ${chainId} (${budget.balanceWei} wei, ${budget.reserveWei} wei ` +
      `reserved) cannot pay one redemption of ${items} at ${budget.maxFeePerGas} wei per gas ` +
      `(${gasLimit} gas for ${items}); nothing was broadcast and the pass ends`;
    this.logger.error(`${EVM_REDEEMER_FLOAT_SHORT_LOG_TAG} ${detail}`);
    return new EvmSendRejectedError('INSUFFICIENT_FUNDS', null, detail);
  }

  /**
   * Which recorded transaction redeemed this voucher: a mined, successful one
   * from the escrow that emitted `VoucherRedeemed` for this payer, seq and
   * request hash. `null` when none did.
   *
   * Asked after a terminal refusal — typically `VoucherSeqUsed`, which is what
   * a voucher that already landed gets (D-23). Once the seq is used a
   * transaction still pending cannot redeem this voucher any more — it will
   * revert. It is still
   * "cannot tell yet" (a throw, so the hold waits a pass) rather than "did not
   * land": the state read and this read may come from RPC nodes a block apart.
   * A hash the node has never seen was dropped, or never broadcast (it is
   * recorded before the broadcast), and did not land.
   */
  async findLanding(
    request: RedeemVoucherRequest,
    txRefs: readonly string[],
  ): Promise<string | null> {
    const chainId = this.chainOf(request);
    const client = this.client(chainId) as EvmLandingClient;
    if (!client.getTransactionReceipt || !client.getTransaction) {
      throw new Error(`the JSON-RPC client for ${chainId} cannot read receipts`);
    }
    const voucher = this.toVoucher(request);
    const escrow = getAddress(this.deployment(chainId).escrow);
    let pending: string | null = null;

    for (const ref of txRefs) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(ref)) continue;
      const hash = ref as `0x${string}`;
      let receipt: Awaited<ReturnType<NonNullable<EvmLandingClient['getTransactionReceipt']>>>;
      try {
        receipt = await client.getTransactionReceipt({ hash });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        try {
          await client.getTransaction({ hash });
          pending = hash;
        } catch (lookup) {
          if (!isNotFound(lookup)) throw lookup;
        }
        continue;
      }
      if (receipt.status !== 'success') continue;
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== escrow) continue;
        let decoded: { eventName: string; args: unknown };
        try {
          decoded = decodeEventLog({ abi: ASSAY_ESCROW_ABI, data: log.data, topics: log.topics });
        } catch {
          continue;
        }
        if (decoded.eventName !== 'VoucherRedeemed') continue;
        const args = decoded.args as { payer: string; seq: bigint; requestHash: string };
        if (
          getAddress(args.payer) === voucher.payer &&
          args.seq === voucher.seq &&
          args.requestHash.toLowerCase() === voucher.requestHash
        ) {
          return hash;
        }
      }
    }

    if (pending !== null) {
      throw new Error(`redemption ${pending} of seq ${request.seq} is still pending`);
    }
    return null;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * The limit a redemption of `vouchers` is sent with: the execution budget
   * plus the L1 part padded 20 %. `null` when that limit at the L2 basefee would
   * cost more than {@link EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM} per voucher —
   * nothing is simulated or sent, and the caller defers. Never `null` when
   * `urgent` (a voucher within {@link EVM_FEE_CAP_WAIVED_WITHIN_SECONDS} of its
   * deadline): deferring it any further would lose the payment, not the gas.
   */
  private async gasLimit(
    chainId: ChainId,
    data: `0x${string}`,
    vouchers: number,
    urgent: boolean,
  ): Promise<bigint | null> {
    const to = getAddress(this.deployment(chainId).escrow);
    const { l1Gas, l2BaseFee } = await estimateL1Gas(this.client(chainId), { to, data });
    const gasLimit = gasFor(vouchers) + paddedL1Gas(l1Gas);
    const maxWei = EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM * BigInt(vouchers);
    if (urgent && exceedsCostCap(gasLimit, l2BaseFee, maxWei)) {
      this.logger.warn(
        `A redemption of ${vouchers} on ${chainId} is above the ${maxWei} wei cap ` +
          `(${gasLimit} gas, L1 ${l1Gas}) but a voucher in it is near its deadline: sending anyway`,
      );
      return gasLimit;
    }
    if (exceedsCostCap(gasLimit, l2BaseFee, maxWei)) {
      this.logger.warn(
        `A redemption of ${vouchers} on ${chainId} was deferred: ${gasLimit} gas (L1 ${l1Gas}) ` +
          `at ${l2BaseFee} wei is above the ${maxWei} wei cap; nothing was sent`,
      );
      return null;
    }
    return gasLimit;
  }

  /**
   * `eth_call` of the exact redemption, FROM the redeemer and WITH the gas it
   * will be sent with. `null` when it would succeed; otherwise the refusal's
   * `Errors.sol` name (`UNKNOWN_REVERT:…` when it has none, e.g. out of gas). An
   * RPC that cannot answer throws: nothing is sent on a guess.
   */
  private async simulate(
    chainId: ChainId,
    functionName: 'redeemVoucher' | 'redeemVoucherBatch',
    args: readonly unknown[],
    gas: bigint,
  ): Promise<string | null> {
    const sender = getAddress(parseAccountId(await this.redeemer.address(chainId)).address);
    try {
      await this.client(chainId).readContract({
        address: getAddress(this.deployment(chainId).escrow),
        abi: ASSAY_ESCROW_ABI,
        functionName,
        args,
        account: sender,
        gas,
      } as Parameters<EvmReaderClient['readContract']>[0]);
      return null;
    } catch (error) {
      const data = revertDataOf(error);
      if (data !== null) return evmErrorName(data);
      if (
        isRevert(error) ||
        /out of gas|execution reverted|gas required exceeds/i.test(messageOf(error))
      ) {
        return 'UNKNOWN_REVERT:none';
      }
      throw error;
    }
  }

  /**
   * `msg.sender`, `paused()`, every payer's escrow, every provider's stake
   * (for its free bonded stake, D-26), every voucher's `held(payer, seq)` record (whether the seq is
   * already used, D-23) and the block's own timestamp — in **one**
   * `multicall`. Windows and deadlines are pre-validated against that
   * timestamp, not this process's clock (review 2026-10-23 L-4). On an escrow with the tighten delay (D-21)
   * the same multicall also asks `effectiveCapsOf(payer, delegate)` per item:
   * the caps `_redeem` applies NOW, and whether the delegate can still sign
   * (`docs/gas.md`'s prevalidation rule). The window COUNTERS still come from
   * `escrowOf` / `delegationOf`, which is where the chain keeps them.
   *
   * Rule 3 above is the chain's: `params()` is read once for the whole batch, so
   * every item settles against one parameter set. Reading it once here is the
   * off-chain half of the same property — pre-validating item 40 against a
   * different `minimumStake` from item 1 would predict a refusal the chain never
   * makes.
   */
  private async readState(
    chainId: ChainId,
    requests: readonly RedeemVoucherRequest[],
  ): Promise<readonly PrevalidationState[]> {
    const deployment = this.deployment(chainId);
    const client = this.client(chainId);
    const config = getAddress(deployment.config);

    const payers = requests.map((request) => this.addressOf(request.payer, chainId));
    const providers = requests.map((request) => this.addressOf(request.provider, chainId));
    const effective = (await this.tightenDelay?.isLive(chainId)) ?? false;
    const signers = requests.map((request) =>
      request.delegate ? this.addressOf(request.delegate, chainId) : zeroAddress,
    );

    const [redeemerAddress, results] = await Promise.all([
      this.redeemer.address(chainId),
      client.multicall({
        contracts: [
          { address: config, abi: ASSAY_CONFIG_ABI, functionName: 'params', args: [] },
          { address: config, abi: ASSAY_CONFIG_ABI, functionName: 'paused', args: [] },
          ...payers.map((payer) => ({
            address: getAddress(deployment.escrow),
            abi: ASSAY_ESCROW_ABI,
            functionName: 'escrowOf',
            args: [payer] as readonly unknown[],
          })),
          // `stakeOf`, not `bondedOf`: the redeem gate reads FREE bonded stake,
          // `bonded − pendingSlash` (D-26). Computed here from the struct
          // (`freeBondedStake`), which every deployed AssayStake answers.
          ...providers.map((provider) => ({
            address: getAddress(deployment.stake),
            abi: ASSAY_STAKE_ABI,
            functionName: 'stakeOf',
            args: [provider] as readonly unknown[],
          })),
          ...(effective
            ? payers.map((payer, index) => ({
                address: getAddress(deployment.escrow),
                abi: ASSAY_ESCROW_ABI,
                functionName: 'effectiveCapsOf',
                args: [payer, signers[index]] as readonly unknown[],
              }))
            : []),
          ...requests.map((request, index) => ({
            address: getAddress(deployment.escrow),
            abi: ASSAY_ESCROW_HOLD_ABI,
            functionName: 'held',
            args: [payers[index], BigInt(request.seq)] as readonly unknown[],
          })),
          // The chain's clock, from the same block as the state above.
          {
            address: MULTICALL3_ADDRESS,
            abi: MULTICALL3_CLOCK_ABI,
            functionName: 'getCurrentBlockTimestamp',
            args: [],
          },
        ],
        allowFailure: false,
      }),
    ]);

    const heldOffset = 2 + payers.length + providers.length + (effective ? payers.length : 0);
    const expected = heldOffset + requests.length + 1;
    if (results.length !== expected) {
      throw ChainErrors.rpcReplyMalformed({
        method: 'multicall(redeem state)',
        expected,
        actual: results.length,
      });
    }

    const params = results[0] as { redeemer: string; minimumStake: bigint };
    const paused = results[1] as boolean;
    // The redeemer key's own address, compared against the key the contract accepts.
    // `NotRedeemer` is checked before `_redeem` runs at all, so this is the
    // first thing the pre-validator asks.
    const redeemerIsUs =
      getAddress(parseAccountId(redeemerAddress).address) === getAddress(params.redeemer);
    // The CHAIN's clock decides what the chain will refuse (review 2026-10-23
    // L-4): `VoucherExpired` is terminal, and a sequencer whose timestamps lag
    // the wall clock still accepts a voucher this process would call expired.
    const nowSeconds = Number(results[expected - 1] as bigint);
    this.checkClockDrift(chainId, nowSeconds);

    // `[maxVoucherAmount, maxPerWindow, delegateMaxVoucherAmount, delegateMaxPerWindow]`.
    const effectiveCaps = (index: number) =>
      effective
        ? (results[2 + payers.length + providers.length + index] as readonly [
            bigint,
            bigint,
            bigint,
            bigint,
          ])
        : null;

    const delegated = requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => request.delegate);
    const grants = new Map<number, PrevalidationDelegation>();
    if (delegated.length > 0) {
      const reads = await client.multicall({
        contracts: delegated.map(({ request }) => ({
          address: getAddress(deployment.escrow),
          abi: ASSAY_ESCROW_ABI,
          functionName: 'delegationOf',
          args: [
            this.addressOf(request.payer, chainId),
            this.addressOf(request.delegate as AccountId, chainId),
          ] as readonly unknown[],
        })),
        allowFailure: false,
      });
      delegated.forEach(({ index }, i) => {
        const grant = reads[i] as {
          maxVoucherAmount: bigint;
          maxPerWindow: bigint;
          spentInWindow: bigint;
          windowStartedAt: bigint;
          validUntil: bigint;
          revoked: boolean;
        };
        const caps = effectiveCaps(index);
        grants.set(index, {
          // Delegate caps 0 = the grant cannot sign now (`effectiveCapsOf`).
          maxVoucherAmount: caps ? caps[2] : grant.maxVoucherAmount,
          maxPerWindow: caps ? caps[3] : grant.maxPerWindow,
          spentInWindow: grant.spentInWindow,
          windowStartedAt: Number(grant.windowStartedAt),
          validUntil: grant.validUntil,
          revoked: grant.revoked,
          ...(caps ? { canSign: caps[2] > 0n } : {}),
        });
      });
    }

    return requests.map((_, index) => {
      const escrow = results[2 + index] as {
        balance: bigint;
        seqHigh: bigint;
        maxVoucherAmount: bigint;
        maxPerWindow: bigint;
        spentInWindow: bigint;
        windowStartedAt: bigint;
      };
      const stake = results[2 + payers.length + index] as {
        bonded: bigint;
        pendingSlash: bigint;
      };
      const caps = effectiveCaps(index);
      // `HeldStatus.None` is 0: anything else means the seq is used for good.
      const held = results[heldOffset + index] as { status: number | bigint };
      return {
        nowSeconds,
        paused,
        redeemerIsUs,
        seqHigh: escrow.seqHigh,
        seqUsed: Number(held.status) !== 0,
        maxVoucherAmount: caps ? caps[0] : escrow.maxVoucherAmount,
        maxPerWindow: caps ? caps[1] : escrow.maxPerWindow,
        spentInWindow: escrow.spentInWindow,
        windowStartedAt: Number(escrow.windowStartedAt),
        balance: escrow.balance,
        providerFreeBonded: freeBondedStake(stake),
        minimumStake: params.minimumStake,
        delegation: grants.get(index) ?? null,
      };
    });
  }

  /**
   * Reports a chain clock more than {@link EVM_CLOCK_DRIFT_WARN_SECONDS} from
   * this process's: a warning log on every read, and one alert per hour per
   * chain. Nothing is refused on it — the chain's clock is what the chain
   * applies — but deadlines, withdrawals and revocations all move with it.
   */
  private checkClockDrift(chainId: ChainId, chainSeconds: number): void {
    const wallSeconds = Math.floor(this.config.now() / 1000);
    const drift = chainSeconds - wallSeconds;
    if (Math.abs(drift) <= EVM_CLOCK_DRIFT_WARN_SECONDS) return;
    this.logger.warn(
      `${chainId}: block.timestamp is ${drift}s ${drift > 0 ? 'ahead of' : 'behind'} this ` +
        `process's clock (more than ${EVM_CLOCK_DRIFT_WARN_SECONDS}s)`,
    );
    void this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: EVM_CLOCK_DRIFT_ALERT,
      summary:
        `The chain's block.timestamp on ${chainId} is ${drift}s from this process's clock; ` +
        `voucher deadlines, withdrawals and revocations move with the chain's`,
      details: { chainId, driftSeconds: drift, chainSeconds, wallSeconds },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${EVM_CLOCK_DRIFT_ALERT}:${chainId}`,
      suppressionWindowSeconds: 3_600,
    });
  }

  /**
   * Rule 2, asserted rather than assumed.
   *
   * The same `(payer, seq)` twice in one batch is this job's own bug — one
   * hold handed over twice — and the chain reverts the second copy with
   * `VoucherSeqUsed`, taking every other item with it. Two different seqs of
   * one payer are fine (D-23).
   */
  private assertNoDuplicateVoucher(requests: readonly RedeemVoucherRequest[]): void {
    const seen = new Set<string>();
    for (const request of requests) {
      const key = `${request.payer.toLowerCase()}#${BigInt(request.seq)}`;
      if (seen.has(key)) {
        throw ChainErrors.payloadMalformed({
          reason:
            `a redemption batch carries seq ${request.seq} of ${request.payer} twice; ` +
            `the second copy would revert the whole batch with VoucherSeqUsed`,
        });
      }
      seen.add(key);
    }
  }

  /**
   * The port's `RedeemVoucherRequest`, as the eight signed fields.
   *
   * Every one of them is carried rather than recomputed: they are exactly the
   * bytes the buyer's wallet signed, and reconstructing even one differently
   * produces a digest `ecrecover` answers a different address for, which the
   * contract refuses as `SignerIsNotPayer` after the call has been served.
   */
  private toVoucher(request: RedeemVoucherRequest): EvmVoucher {
    const chainId = this.chainOf(request);
    return {
      payer: this.addressOf(request.payer, chainId),
      provider: this.addressOf(request.provider, chainId),
      amount: this.uint64(MoneyUtil.toAtomic(request.amount), 'amount'),
      resourceHash: this.bytes32(request.resourceHash, HASH_PREFIX, 'resourceHash'),
      requestHash: this.bytes32(request.requestHash, HASH_PREFIX, 'requestHash'),
      seq: this.uint64(BigInt(request.seq), 'seq'),
      issuedAt: this.uint64(BigInt(request.issuedAt), 'issuedAt'),
      expiresAt: this.uint64(BigInt(request.expiresAt), 'expiresAt'),
    };
  }

  /**
   * The buyer's signature, as `r || s || v`.
   *
   * The port's field comment says "base58" — that is Solana's vocabulary, and it
   * is the shape a Solana wallet produces. On `eip155` a wallet produces 65
   * bytes of hex, and this is where the difference is checked rather than
   * discovered by a revert: `InvalidSignature` costs a transaction to learn.
   */
  private signatureOf(request: RedeemVoucherRequest): `0x${string}` {
    if (!SECP256K1_SIGNATURE_RE.test(request.signature)) {
      throw ChainErrors.payloadMalformed({
        reason: 'a voucher signature on eip155 is 65 bytes of hex (r || s || v)',
      });
    }
    return request.signature as `0x${string}`;
  }

  private bytes32(value: string, prefix: string, field: string): `0x${string}` {
    const hex = prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw ChainErrors.payloadMalformed({ reason: `${field} is not 32 bytes of hex` });
    }
    return `0x${hex.toLowerCase()}` as `0x${string}`;
  }

  private uint64(value: bigint, field: string): bigint {
    if (value < 0n || value > 2n ** 64n - 1n) {
      throw ChainErrors.payloadMalformed({
        reason: `${field} does not fit the uint64 the voucher declares`,
      });
    }
    return value;
  }

  /**
   * The `Errors.sol` name as an outcome kind.
   *
   * One table, consulted by both the pre-validation path and the revert path, so
   * the two cannot disagree about what a name means. An **unnamed** refusal is
   * `RETRY` and never `UNREDEEMABLE`: closing a hold because we could not read
   * the reason is how a buyer is put in debt for nothing.
   */
  /**
   * {@link outcomeFor}, except that a `VoucherExpired` is NOT made final while
   * the chain's clock — one RPC node's `block.timestamp` — runs more than
   * {@link EVM_CLOCK_DRIFT_WARN_SECONDS} ahead of this process's and the
   * voucher is still live at `wall + tolerance` (review 2026-10-24, chain clock
   * robustness). `VoucherExpired` is terminal — buyer debt or a provider
   * forfeit — and a node answering a future time must not decide that alone.
   * The decision is held: a bare `RETRY` (no program error, so nothing
   * recorded on the intent changes), and one warning line tagged
   * {@link EVM_EXPIRY_HELD_LOG_TAG} for whatever counts or pages on it. Once
   * the wall clock agrees, the next pass finalizes it.
   */
  private decided(
    chainId: ChainId,
    name: string | null,
    voucher: EvmVoucher,
    state: PrevalidationState,
  ): RedeemOutcome {
    if (name === 'VoucherExpired') {
      const wallSeconds = Math.floor(this.config.now() / 1000);
      const ahead = state.nowSeconds - wallSeconds;
      const deadline = voucher.expiresAt + BigInt(EVM_CONSTANTS.REDEEM_GRACE_SECONDS);
      const trusted = BigInt(wallSeconds + EVM_CLOCK_DRIFT_WARN_SECONDS);
      if (ahead > EVM_CLOCK_DRIFT_WARN_SECONDS && trusted <= deadline) {
        this.logger.warn(
          `${EVM_EXPIRY_HELD_LOG_TAG} ${chainId}: seq ${voucher.seq} of ${voucher.payer} was ` +
            `refused VoucherExpired on a block.timestamp ${ahead}s ahead of this process's ` +
            `clock (tolerance ${EVM_CLOCK_DRIFT_WARN_SECONDS}s); its deadline ${deadline} is ` +
            `not past by the wall clock, so the decision is held and retried`,
        );
        return { kind: RedeemOutcomeKind.RETRY, signature: null, programError: null };
      }
    }
    return this.outcomeFor(name, null);
  }

  private outcomeFor(name: string | null, signature: string | null): RedeemOutcome {
    const programError = name ?? 'UNKNOWN_REVERT:none';

    if (programError === 'ProgramPaused') {
      return { kind: RedeemOutcomeKind.PAUSED, signature, programError };
    }
    if (MISCONFIGURATION.has(programError)) {
      return { kind: RedeemOutcomeKind.MISCONFIGURED, signature, programError };
    }
    if (UNREDEEMABLE.has(programError)) {
      return { kind: RedeemOutcomeKind.UNREDEEMABLE, signature, programError };
    }
    if (!RETRYABLE.has(programError)) {
      void this.alertUnknownRefusal(programError);
    }
    return { kind: RedeemOutcomeKind.RETRY, signature, programError };
  }

  /**
   * A refusal nobody can name is a hole in the error table or a chain that
   * changed underneath this deployment.
   *
   * `ONCE_PER_INCIDENT` on the selector: an unmapped error otherwise produces
   * one page per hold per pass, which is how a channel gets muted — and a muted
   * channel costs every other alert on it its audience.
   */
  private async alertUnknownRefusal(programError: string): Promise<void> {
    await this.alerts.emit({
      severity: AlertSeverity.CRITICAL,
      name: EVM_REDEEM_UNKNOWN_REVERT_ALERT,
      summary:
        `A voucher redemption was refused with ${programError}, which no entry in the ` +
        `Errors.sol table names. The hold stays open and is retried.`,
      details: { programError },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${EVM_REDEEM_UNKNOWN_REVERT_ALERT}:${programError}`,
    });
  }

  private oneChain(requests: readonly RedeemVoucherRequest[]): ChainId {
    const chainId = this.chainOf(requests[0]);
    for (const request of requests) {
      if (this.chainOf(request) !== chainId) {
        throw ChainErrors.payloadMalformed({
          reason: `a redemption batch spans ${chainId} and ${this.chainOf(request)}`,
        });
      }
    }
    return chainId;
  }

  private chainOf(request: RedeemVoucherRequest): ChainId {
    const { chainId } = parseAccountId(request.payer);
    if (!this.deployments.has(chainId)) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
    return chainId;
  }

  /** EIP-55, strictly, and on the chain the caller named. */
  private addressOf(account: AccountId, chainId: ChainId): `0x${string}` {
    const parsed = parseAccountId(account);
    if (parsed.chainId !== chainId) {
      throw ChainErrors.invalidAccountId({ value: `${account} is not on ${chainId}` });
    }
    if (!isAddress(parsed.address, { strict: true })) {
      throw ChainErrors.invalidAddress({ chainId, address: parsed.address });
    }
    return getAddress(parsed.address);
  }

  private escrowAccount(chainId: ChainId): AccountId {
    return toAccountId(chainId, getAddress(this.deployment(chainId).escrow));
  }

  private deployment(chainId: ChainId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
    return deployment;
  }

  private client(chainId: ChainId): EvmReaderClient {
    const client = this.clients.get(chainId);
    if (!client) {
      throw ChainErrors.programNotConfigured({
        what: `a JSON-RPC client for ${chainId}`,
        variable: 'EVM_RPC_URLS',
      });
    }
    return client;
  }
}

/**
 * The two reads {@link EvmVoucherRedeemer.findLanding} needs beyond
 * `EvmReaderClient`. The viem public client behind `EVM_RPC_CLIENTS` has both.
 */
interface EvmLandingClient extends EvmReaderClient {
  getTransactionReceipt?(args: { hash: `0x${string}` }): Promise<{
    status: 'success' | 'reverted';
    logs: readonly {
      address: string;
      data: `0x${string}`;
      topics: [] | [`0x${string}`, ...`0x${string}`[]];
    }[];
  }>;
  getTransaction?(args: { hash: `0x${string}` }): Promise<unknown>;
}

/** viem's `TransactionReceiptNotFoundError` / `TransactionNotFoundError`. */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return (
    name === 'TransactionReceiptNotFoundError' ||
    name === 'TransactionNotFoundError' ||
    /could not be found/i.test(messageOf(error))
  );
}

/** Whether any of `vouchers` is within {@link EVM_FEE_CAP_WAIVED_WITHIN_SECONDS} of its on-chain deadline. */
function nearDeadline(vouchers: readonly EvmVoucher[], nowSeconds: number): boolean {
  const window = BigInt(EVM_FEE_CAP_WAIVED_WITHIN_SECONDS);
  return vouchers.some(
    (voucher) =>
      voucher.expiresAt + BigInt(EVM_CONSTANTS.REDEEM_GRACE_SECONDS) - BigInt(nowSeconds) <= window,
  );
}

function gasFor(vouchers: number): bigint {
  return EVM_REDEEM_BATCH_BASE_GAS + EVM_REDEEM_PER_VOUCHER_GAS * BigInt(vouchers);
}

/**
 * How many of `items` a send fits in the budget: the largest `k` whose limit,
 * `gasFor(k)` plus the L1 part scaled to `k` (calldata grows with the items),
 * at the budget's fee is within what it may spend. The send itself is then
 * sized exactly; the relayer refuses anything this estimate got wrong before
 * signing it.
 */
function fitCount(items: number, gasLimit: bigint, budget: EvmSendBudget): number {
  const n = BigInt(items);
  const l1 = gasLimit > gasFor(items) ? gasLimit - gasFor(items) : 0n;
  for (let k = items; k > 0; k -= 1) {
    const kk = BigInt(k);
    const limit = gasFor(k) + (l1 * kk + n - 1n) / n;
    if (limit * budget.maxFeePerGas <= budget.spendableWei) return k;
  }
  return 0;
}

/** The arguments one redemption batch is assembled from. */
interface BatchContext {
  readonly chainId: ChainId;
  readonly requests: readonly RedeemVoucherRequest[];
  readonly vouchers: readonly EvmVoucher[];
  readonly signatures: readonly `0x${string}`[];
  readonly outcomes: (RedeemOutcome | undefined)[];
  /** The items that passed pre-validation; the rest are decided from the start. */
  readonly admissible: readonly number[];
}

function messageOf(error: unknown): string {
  let current: unknown = error;
  const parts: string[] = [];
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}
