import { Inject, Injectable, Logger } from '@nestjs/common';
import { encodeFunctionData, getAddress, isAddress } from 'viem';

import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
  VoucherRedeemerPort,
} from '@modules/payment/ports/voucher-redeemer.port';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { AccountId, ChainId, parseAccountId, toAccountId } from '../ports/caip.types';
import { X402_CONFIG_ABI, X402_ESCROW_ABI, X402_STAKE_ABI } from './abi/x402.abi';
import { EvmVoucher } from './eip712/voucher';
import { EVM_CONSTANTS, EvmDeployment } from './evm.constants';
import { EvmReaderClient } from './evm-escrow-balance-reader.service';
import {
  PrevalidationDelegation,
  PrevalidationState,
  prevalidateVoucher,
} from './evm-voucher-prevalidation';
import { isRevert } from './evm-voucher-authority';
import { evmErrorName, revertDataOf } from './abi/error-selectors';
import { EVM_REDEEMER, EvmRelayerPort } from './ports/evm-relayer.port';

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
 */
export const EVM_REDEEM_BATCH_BASE_GAS = 200_000n;
export const EVM_REDEEM_PER_VOUCHER_GAS = 120_000n;

/** The alert a refusal nobody can name raises. */
export const EVM_REDEEM_UNKNOWN_REVERT_ALERT = 'evm_redeem_unknown_revert';

export interface EvmVoucherRedeemerConfig {
  /** Milliseconds, `Date.now()`'s own unit. The chain's timestamps are seconds. */
  readonly now: () => number;
}

/**
 * Refusals about the **deployment**, not about the voucher.
 *
 * Every hold on the platform is refused identically until a human acts, so
 * `RETRY` would burn a fee per hold per pass for ever and `UNREDEEMABLE` would
 * hand every buyer their money back — and pay every provider out of platform
 * funds — for a fault one `updateConfig` fixes.
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
 * fixed. When one comes back the buyer keeps their money and the platform pays
 * the provider anyway — the rule is that neither party bears it.
 */
const UNREDEEMABLE: ReadonlySet<string> = new Set([
  'ZeroAmount',
  'InvalidVoucherWindow',
  'VoucherLifetimeTooLong',
  'VoucherExpired',
  'VoucherSeqZero',
  'VoucherSeqNotIncreasing',
  // The seq is more than MAX_SEQ_GAP above the payer's seqHigh. seqHigh only
  // grows, so a later attempt can only stay refused or become
  // VoucherSeqNotIncreasing — never settle on a different answer worth gas.
  'VoucherSeqGapTooLarge',
  'SignerIsNotPayer',
  'InvalidSignature',
  'MalleableSignature',
  'BadSignatureV',
  // Agent payment delegation. Only a NEW grant by the payer revives any of
  // these, and the payer then decides afresh; retrying until the voucher's
  // deadline only re-broadcasts a known refusal (review S2-2).
  'DelegateIsRevoked',
  'DelegateIsExpired',
  'DelegateVoucherExceedsPerCallLimit',
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
 *     each other in no way; one payer's items must be ordered among themselves.
 *     Sorting a batch by `seq` globally is wrong.
 *  2. **The same voucher twice in one batch reverts the batch** — the second
 *     copy fails `seq > seqHigh`, because the first already advanced it.
 *  3. **The parameter set is read once for the whole batch**: every item settles
 *     against the treasury and take rate current when the batch started, even if
 *     a `Config` update lands mid transaction.
 *
 * This class takes the simplest arrangement that satisfies 1 and 2 at once:
 * **at most one voucher per payer per batch**, asserted rather than assumed. It
 * costs nothing — `VoucherRedemptionService` already blocks a payer for the rest
 * of a pass after one of theirs does not land — and it removes an entire class
 * of ordering bug rather than managing it. It costs about 27 500 gas per voucher
 * against the one-payer shape, which is the price of the guarantee.
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
  ) {}

  async redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome> {
    const chainId = this.chainOf(request);
    const voucher = this.toVoucher(request);
    const [state] = await this.readState(chainId, [request]);

    // Pre-validated on the single path too. A retry after a batch revert reads
    // state that may have moved since the batch was assembled, and a hold whose
    // refusal is now different has to be reported as what it is now.
    const refusal = prevalidateVoucher(voucher, state);
    if (refusal !== null) {
      return this.outcomeFor(refusal, null);
    }

    // Simulated with the redeemer as sender and the gas it will be sent with,
    // so a refusal pre-validation cannot see — the signature, a wallet's answer —
    // costs an `eth_call` and never a mined revert (review S2-2).
    const args = [voucher, this.signatureOf(request)] as const;
    const simulated = await this.simulate(chainId, 'redeemVoucher', args, gasFor(1));
    if (simulated !== null) {
      return this.outcomeFor(simulated, null);
    }

    const result = await this.redeemer.sendCall({
      chainId,
      to: this.escrowAccount(chainId),
      data: encodeFunctionData({
        abi: X402_ESCROW_ABI,
        functionName: 'redeemVoucher',
        args,
      }),
      gasLimit: gasFor(1),
      purpose: `redeemVoucher seq=${request.seq}`,
    });

    if (result.status === 'SUCCESS') {
      return { kind: RedeemOutcomeKind.REDEEMED, signature: result.hash, programError: null };
    }
    return this.outcomeFor(result.revertReason, null);
  }

  async redeemBatch(requests: readonly RedeemVoucherRequest[]): Promise<readonly RedeemOutcome[]> {
    if (requests.length === 0) {
      return [];
    }
    this.assertOnePerPayer(requests);
    if (requests.length > EVM_CONSTANTS.MAX_REDEEM_BATCH) {
      throw ChainErrors.payloadMalformed({
        reason: `a redemption batch of ${requests.length} exceeds MAX_REDEEM_BATCH (64)`,
      });
    }

    const chainId = this.oneChain(requests);
    const vouchers = requests.map((request) => this.toVoucher(request));
    const signatures = requests.map((request) => this.signatureOf(request));
    const states = await this.readState(chainId, requests);
    const refusals = vouchers.map((voucher, index) => prevalidateVoucher(voucher, states[index]));

    // The batch is only the ones that would settle. Submitting a known-bad item
    // is submitting a transaction we already know reverts, and it takes 63 good
    // ones with it.
    const admissible = requests
      .map((_, index) => index)
      .filter((index) => refusals[index] === null);
    if (admissible.length === 0) {
      return refusals.map((name) => this.outcomeFor(name, null));
    }

    // SIMULATE the batch first, with the gas it will be sent with. A batch the
    // chain would refuse is never broadcast: it goes straight to the singles,
    // each of which simulates again (review S2-2).
    const batchArgs = [
      admissible.map((i) => vouchers[i]),
      admissible.map((i) => signatures[i]),
    ] as const;
    const simulated = await this.simulate(
      chainId,
      'redeemVoucherBatch',
      batchArgs,
      gasFor(admissible.length),
    );
    if (simulated !== null) {
      this.logger.warn(
        `A redemption batch of ${admissible.length} would revert with ${simulated}; ` +
          `nothing was broadcast — redeeming the items singly`,
      );
      const outcomes: RedeemOutcome[] = refusals.map((name) => this.outcomeFor(name, null));
      for (const index of admissible) {
        outcomes[index] = await this.redeem(requests[index]);
      }
      return outcomes;
    }

    const result = await this.redeemer.sendCall({
      chainId,
      to: this.escrowAccount(chainId),
      data: encodeFunctionData({
        abi: X402_ESCROW_ABI,
        functionName: 'redeemVoucherBatch',
        args: [admissible.map((i) => vouchers[i]), admissible.map((i) => signatures[i])],
      }),
      gasLimit: gasFor(admissible.length),
      purpose: `redeemVoucherBatch n=${admissible.length}`,
    });

    if (result.status === 'SUCCESS') {
      return refusals.map((name, index) =>
        refusals[index] === null
          ? { kind: RedeemOutcomeKind.REDEEMED, signature: result.hash, programError: null }
          : this.outcomeFor(name, null),
      );
    }

    // RETRY SINGLY. The batch reverted, so we do not know WHICH item did it:
    // pre-validation reads state that may have moved between the read and the
    // send, and a revert is a 4-byte selector with no index. Re-submitting the
    // batch would fail identically, for ever. One transaction each is slower and
    // it is the only thing that makes progress.
    this.logger.warn(
      `A redemption batch of ${admissible.length} reverted with ` +
        `${result.revertReason ?? 'an unreadable reason'}; retrying the items singly`,
    );

    const outcomes: RedeemOutcome[] = refusals.map((name) => this.outcomeFor(name, null));
    for (const index of admissible) {
      outcomes[index] = await this.redeem(requests[index]);
    }
    return outcomes;
  }

  // ── Internals ────────────────────────────────────────────────────────────

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
        abi: X402_ESCROW_ABI,
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
   * `msg.sender`, `paused()`, every payer's escrow and every provider's bonded
   * stake — in **one** `multicall`.
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

    const [redeemerAddress, results] = await Promise.all([
      this.redeemer.address(chainId),
      client.multicall({
        contracts: [
          { address: config, abi: X402_CONFIG_ABI, functionName: 'params', args: [] },
          { address: config, abi: X402_CONFIG_ABI, functionName: 'paused', args: [] },
          ...payers.map((payer) => ({
            address: getAddress(deployment.escrow),
            abi: X402_ESCROW_ABI,
            functionName: 'escrowOf',
            args: [payer] as readonly unknown[],
          })),
          ...providers.map((provider) => ({
            address: getAddress(deployment.stake),
            abi: X402_STAKE_ABI,
            functionName: 'bondedOf',
            args: [provider] as readonly unknown[],
          })),
        ],
        allowFailure: false,
      }),
    ]);

    const expected = 2 + payers.length + providers.length;
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
    const nowSeconds = Math.floor(this.config.now() / 1000);

    const delegated = requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => request.delegate);
    const grants = new Map<number, PrevalidationDelegation>();
    if (delegated.length > 0) {
      const reads = await client.multicall({
        contracts: delegated.map(({ request }) => ({
          address: getAddress(deployment.escrow),
          abi: X402_ESCROW_ABI,
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
        grants.set(index, {
          maxVoucherAmount: grant.maxVoucherAmount,
          maxPerWindow: grant.maxPerWindow,
          spentInWindow: grant.spentInWindow,
          windowStartedAt: Number(grant.windowStartedAt),
          validUntil: grant.validUntil,
          revoked: grant.revoked,
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
      const bonded = results[2 + payers.length + index] as bigint;
      return {
        nowSeconds,
        paused,
        redeemerIsUs,
        seqHigh: escrow.seqHigh,
        maxVoucherAmount: escrow.maxVoucherAmount,
        maxPerWindow: escrow.maxPerWindow,
        spentInWindow: escrow.spentInWindow,
        windowStartedAt: Number(escrow.windowStartedAt),
        balance: escrow.balance,
        providerBonded: bonded,
        minimumStake: params.minimumStake,
        delegation: grants.get(index) ?? null,
      };
    });
  }

  /**
   * Rule 2, asserted rather than assumed.
   *
   * A duplicate payer in one batch is not a rare accident: it is what the
   * obvious `pending.slice(0, 64)` produces the first time a buyer has two
   * vouchers waiting, and the batch it builds reverts on the second copy and
   * takes every other item with it.
   */
  private assertOnePerPayer(requests: readonly RedeemVoucherRequest[]): void {
    const seen = new Set<string>();
    for (const request of requests) {
      const payer = request.payer.toLowerCase();
      if (seen.has(payer)) {
        throw ChainErrors.payloadMalformed({
          reason:
            `a redemption batch carries two vouchers for the same payer (${request.payer}); ` +
            `seq is per payer, so the second reverts the whole batch`,
        });
      }
      seen.add(payer);
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
   * `RETRY` and never `UNREDEEMABLE`: absorbing a hold because we could not read
   * the reason is how a buyer is charged for nothing.
   */
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

function gasFor(vouchers: number): bigint {
  return EVM_REDEEM_BATCH_BASE_GAS + EVM_REDEEM_PER_VOUCHER_GAS * BigInt(vouchers);
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
