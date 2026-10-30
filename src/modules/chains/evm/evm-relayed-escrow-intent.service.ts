import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { encodeFunctionData, getAddress, isAddress } from 'viem';

import { SettlementErrors } from '@modules/settlement/errors/settlement.errors';
import { EscrowDelegationKind } from '@modules/settlement/ports/escrow-delegation.port';
import { EscrowIntentKind } from '@modules/settlement/ports/escrow-intent-builder.port';
import {
  RelayedEscrowIntent,
  RelayedEscrowIntentPort,
  RelayedEscrowSubmission,
} from '@modules/settlement/ports/relayed-escrow-intent.port';

import { chainMetadata } from '../chain-metadata';
import { ChainErrors } from '../errors/chains.errors';
import { AccountId, AssetId, ChainId, parseAccountId, toAccountId } from '../ports/caip.types';
import { evmErrorName, revertDataOf } from './abi/error-selectors';
import { ASSAY_ESCROW_ABI } from './abi/assay.abi';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from './evm.constants';
import { EvmEscrowBalanceReader } from './evm-escrow-balance-reader.service';
import { EvmL1GasClient, estimateL1Gas, exceedsCostCap } from './evm-l1-gas';
import { EVM_RELAYER, EvmRelayerPort } from './ports/evm-relayer.port';
import { EVM_RELAYER_FLOAT_GATE, RedeemerFloatGate } from './evm-redeemer-float.gate';
import { EVM_RELAYER_HOURLY_BUDGET, EvmRelayerHourlyBudget } from './evm-relayer-hourly-budget';
import { isSendRejected } from './evm-send-rejected.error';

/**
 * Two read calls, and **no send**.
 *
 * The same structural guarantee `EvmEscrowIntentBuilder` and
 * `EvmGasGrantService` make with their own narrow client interfaces: a class
 * that cannot reach `sendRawTransaction` cannot acquire the capability by
 * accident, and a reviewer does not have to establish that nobody did. The send
 * is {@link EvmRelayerPort.sendCall}'s, which queues nonces, decodes reverts and
 * watches the float.
 */
export interface EvmRelayedIntentClient extends EvmL1GasClient {
  estimateGas(args: {
    account: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
  }): Promise<bigint>;
}

/** Every amount argument on `AssayEscrow` is a `uint64`. */
const MAX_UINT64 = 2n ** 64n - 1n;

/** `r || s || v`, 65 bytes. The same shape `EvmVoucherRedeemer` demands. */
const SECP256K1_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/**
 * The gas a relayed `*BySig` call may cost, measured and then bounded.
 *
 * assay-evm's `docs/gas.md` has no figure for either door; the numbers that
 * exist are live measurements — **65,536** for
 * `setLimitsBySig` and **65,638** for `requestWithdrawBySig`, both on a fork of
 * 46630 against the real deployment. This ceiling is 4.5× the larger of them.
 *
 * It is not a budget handed to the relayer — the estimate is, with a 20 %
 * margin. It is the point at which a relayed request is refused rather than
 * paid for, and it exists because **the per-request gas cost is the unit the
 * rate limit is denominated in**: "10 submissions an hour" bounds nothing
 * unless a submission has a known worst case. A call that estimates above this
 * is a call against a contract shaped differently from the one these numbers
 * were taken on, and the right answer to that is to stop rather than to pay
 * whatever it comes to.
 */
export const EVM_RELAYED_INTENT_MAX_GAS = 300_000n;

/**
 * The most wei one relayed request may cost: `gasLimit` (L1 part included) ×
 * the L2 basefee. 0.00001 ETH (review 2026-10-30 I-2 lowered it from 0.00005).
 *
 * {@link EVM_RELAYED_INTENT_MAX_GAS} bounds the **execution** half only; on a
 * Nitro chain the L1 half is a fee, not a shape, and it spikes (`evm-l1-gas.ts`).
 * This is the bound on what a spike may cost: about 4× the ordinary 2.3e-6 ETH
 * of a `setLimitsBySig`, and 1/20 of the relayer's shared hourly budget
 * (`EVM_RELAYER_HOURLY_SPEND_WEI`), so twenty requests at the cap is the worst
 * hour a crowd of strangers can cost. Above it the request is a 503 "try again
 * shortly" — the fees will come down, the signature stays valid until its
 * deadline, and nothing was sent.
 */
export const EVM_RELAYED_INTENT_MAX_COST_WEI = 10_000_000_000_000n;

/**
 * `RelayedEscrowIntentPort` on `eip155` — **the buyer signs, the relayer
 * sends**, and this is the verb that was missing.
 *
 * The platform issues an EIP-712 request, a wallet signs it, and this class
 * takes the signature back and relays it. `EvmRelayerPort.sendCall` is
 * otherwise used only by the voucher batch and `sendValue` only by the gas
 * grant; this is the one production path that encodes the `*BySig`
 * functions.
 *
 * ## What this class decides, and what it deliberately does not
 *
 * **The signature is the authority for what happens; the session is the
 * authority for whether we pay for it.** The contract already refuses a wrong
 * signer (`SignerIsNotBuyer`), a replay (`BadNonce`), a malleable `s`
 * (`MalleableSignature`) and a stale deadline (`SignatureExpired`) — all four
 * proved live — so none of them is re-implemented here. There is no `ecrecover`
 * in this file and there must not be one: a second opinion about a signature is
 * a second thing that can disagree with the chain, and the chain wins.
 *
 * What is decided here is whose gas is spent, in two steps:
 *
 * 1. **The call is encoded from fields, never forwarded.** The request carries
 *    an amount, a pair of limits, a nonce and a deadline; the `to` is the
 *    deployment's escrow and the function is picked by a `switch` on a kind that
 *    cannot be `WITHDRAW`. No caller-supplied bytes choose the target or the
 *    selector, so the relayer gains no capability it did not already have.
 * 2. **A pre-flight `eth_estimateGas` from the relayer's own address.** It
 *    executes the call in the same context the send will, so every refusal the
 *    chain would make arrives here — for the price of one RPC round trip instead
 *    of a reverted transaction's gas. It also returns the gas, so the pre-flight
 *    and the budget are one call rather than two.
 *
 * The `buyer` the call names comes from {@link RelayedEscrowIntent.account},
 * which is the session's own account. `WithdrawalService` refuses a body naming
 * anybody else before reaching this class; encoding from the session here is
 * what makes that refusal a second line rather than the only one.
 *
 * ## A revert is not a 500
 *
 * Both the pre-flight and the send map revert data through the shared
 * `evmErrorName` table, so a buyer is told `BadNonce` or `SignatureExpired`
 * rather than handed a decode failure. `transactionHash` on the refusal is what
 * separates "caught before it cost anything" from "state moved between the
 * pre-flight and the send"; the second is rare and is the one that costs the
 * relayer money, so it is logged as well as reported.
 */
@Injectable()
export class EvmRelayedEscrowIntentSubmitter implements RelayedEscrowIntentPort {
  private readonly logger = new Logger(EvmRelayedEscrowIntentSubmitter.name);

  constructor(
    @Inject(EVM_RPC_CLIENTS)
    private readonly clients: ReadonlyMap<ChainId, EvmRelayedIntentClient>,
    @Inject(EVM_DEPLOYMENTS) private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(EVM_RELAYER) private readonly relayer: EvmRelayerPort,
    /**
     * The relayer's float flag (`RedeemerFloatGate`, relayer half). While it
     * reads critical, a relayed request is a 503 "try again shortly" and the
     * float left is kept for slash sends. Absent: not checked.
     */
    @Optional()
    @Inject(EVM_RELAYER_FLOAT_GATE)
    private readonly floatGate: Pick<RedeemerFloatGate, 'isRelayerCritical'> | null = null,
    /** The relayer's global hourly spend budget. Absent: not checked. */
    @Optional()
    @Inject(EVM_RELAYER_HOURLY_BUDGET)
    private readonly hourly: Pick<EvmRelayerHourlyBudget, 'take' | 'settle'> | null = null,
    /**
     * The escrow read that decides the budget's reserved lane: only an account
     * holding something in its escrow may spend it. Absent: no reserved lane.
     */
    @Optional()
    @Inject(EvmEscrowBalanceReader)
    private readonly escrow: Pick<EvmEscrowBalanceReader, 'read'> | null = null,
  ) {}

  async submit(intent: RelayedEscrowIntent): Promise<RelayedEscrowSubmission> {
    const { chainId, address: buyer } = this.parse(intent.account);
    const deployment = this.deployment(chainId);
    const to = getAddress(deployment.escrow);

    const data = this.encode(intent, buyer);

    // First and free: a relayer whose float is critical takes no buyer request.
    if (await this.floatGate?.isRelayerCritical(chainId)) {
      throw SettlementErrors.relayedIntentUnavailable({ relayerBusy: true });
    }

    const relayer = parseAccountId(await this.relayer.address(chainId)).address as `0x${string}`;

    const { gasLimit, l2BaseFee } = await this.preflight(chainId, relayer, to, data);

    // Last, immediately before the send: a request any check above refused
    // costs the global budget nothing. Charged at `gasLimit × basefee`, or at
    // the per-request cap when the basefee is unknown; settled to the receipt.
    const ticket = this.hourly
      ? await this.hourly.take(chainId, {
          wei: l2BaseFee !== null ? gasLimit * l2BaseFee : EVM_RELAYED_INTENT_MAX_COST_WEI,
          purpose: `relayed ${intent.kind}`,
          funded: () => this.holdsEscrow(intent.account, chainId),
        })
      : null;
    if (this.hourly && !ticket) {
      throw SettlementErrors.relayedIntentUnavailable({ relayerBusy: true });
    }

    let result: Awaited<ReturnType<EvmRelayerPort['sendCall']>>;
    try {
      result = await this.relayer.sendCall({
        chainId,
        to: toAccountId(chainId, to),
        data,
        gasLimit,
        purpose: `${intent.kind} bySig nonce=${intent.nonce}`,
        // A relayed tightening keeps the payer's voucher admission paused until
        // its outcome is known, so the time it may wait behind other sends is
        // bounded (BUG-D1-07 review): past it, it is given up unsent.
        boundQueueWait: true,
      });
    } catch (error) {
      // The node refused it (no ETH, a nonce race): definitely not broadcast,
      // so the signature is untouched and a retry is the right answer.
      if (isSendRejected(error)) {
        this.logger.warn(`a relayed ${intent.kind} on ${chainId} was refused: ${error.message}`);
        throw SettlementErrors.relayedIntentUnavailable({ relayerBusy: true });
      }
      throw error;
    }

    if (ticket && l2BaseFee !== null && typeof result.gasUsed === 'bigint') {
      await this.hourly?.settle(ticket, result.gasUsed * l2BaseFee);
    }

    if (result.status !== 'SUCCESS') {
      // The pre-flight passed and the send still reverted, so state moved between
      // the two — a block mined, or a load balancer answering from two nodes at
      // different heights. This is the branch that costs real gas, so it is
      // logged as well as reported.
      this.logger.warn(
        `a relayed ${intent.kind} for ${intent.account} passed pre-flight and then reverted ` +
          `with ${result.revertReason ?? 'an unreadable reason'} at ${result.hash}`,
      );
      throw SettlementErrors.relayedIntentRefused({
        reason: result.revertReason,
        transactionHash: result.hash,
      });
    }

    return {
      transactionHash: result.hash,
      blockNumber: result.blockNumber.toString(),
      gasUsed: result.gasUsed.toString(),
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Whether `account` holds something in its escrow on chain — a non-zero
   * balance or a withdrawal still pending — which is what admits it to the
   * relayer budget's reserved lane. A buyer who emptied their escrow has
   * nothing left to brake or withdraw, so a zero escrow is "not funded".
   */
  private async holdsEscrow(account: AccountId, chainId: ChainId): Promise<boolean> {
    if (!this.escrow) return false;
    const reading = await this.escrow.read(
      account,
      chainMetadata(chainId).settlementAsset as AssetId,
    );
    if (!reading) return false;
    return BigInt(reading.balance.amount) > 0n || reading.withdrawRequested > 0n;
  }

  /**
   * The calldata, built from **validated fields** against this repository's own
   * vendored ABI.
   *
   * The `switch` is exhaustive over a kind that cannot be `WITHDRAW` — the
   * union excludes it at the type level, because `withdraw()` is
   * `msg.sender`-only and there is no `withdrawBySig` in the contract, in
   * `ASSAY_ESCROW_ABI` or in the deployed bytecode (checked against a live
   * deployment). A `default:` branch here would be a place for one to appear.
   */
  private encode(intent: RelayedEscrowIntent, buyer: `0x${string}`): `0x${string}` {
    const signature = this.signature(intent.signature);
    const nonce = this.uint64(intent.nonce, 'nonce');
    const deadline = this.uint64(intent.deadline, 'deadline');

    switch (intent.kind) {
      case EscrowIntentKind.SET_LIMITS:
        return encodeFunctionData({
          abi: ASSAY_ESCROW_ABI,
          functionName: 'setLimitsBySig',
          args: [
            buyer,
            this.uint64(intent.maxVoucherAmount, 'maxVoucherAmount'),
            this.uint64(intent.maxPerWindow, 'maxPerWindow'),
            nonce,
            deadline,
            signature,
          ],
        });

      case EscrowIntentKind.REQUEST_WITHDRAW:
        return encodeFunctionData({
          abi: ASSAY_ESCROW_ABI,
          functionName: 'requestWithdrawBySig',
          args: [buyer, this.uint64(intent.amount, 'amount'), nonce, deadline, signature],
        });

      // Agent payment delegation. The delegate is inside the signed struct, so
      // the relayer cannot point the payer's consent at a key of its own.
      case EscrowDelegationKind.AUTHORIZE_DELEGATE:
        return encodeFunctionData({
          abi: ASSAY_ESCROW_ABI,
          functionName: 'authorizeDelegateBySig',
          args: [
            buyer,
            this.address(intent.delegate, 'delegate'),
            this.uint64(intent.maxVoucherAmount, 'maxVoucherAmount'),
            this.uint64(intent.maxPerWindow, 'maxPerWindow'),
            this.uint64(intent.validUntil, 'validUntil'),
            nonce,
            deadline,
            signature,
          ],
        });

      case EscrowDelegationKind.REVOKE_DELEGATE:
        return encodeFunctionData({
          abi: ASSAY_ESCROW_ABI,
          functionName: 'revokeDelegateBySig',
          args: [buyer, this.address(intent.delegate, 'delegate'), nonce, deadline, signature],
        });
    }
  }

  /**
   * `eth_estimateGas` **from the relayer's own address**, which is both the
   * pre-flight and the budget.
   *
   * From the relayer's address rather than from the buyer's because that is who
   * will send it: `*BySig` reads the authority out of the signature and not out
   * of `msg.sender`, so the two differ in nothing the contract checks — but an
   * estimate taken from an address that will not be the sender is an estimate of
   * a different transaction, and the day that stops being true it should fail
   * here rather than on chain.
   *
   * Every revert the chain would make arrives as a throw, and the refusal it
   * becomes carries **no transaction hash** — because nothing was sent, and
   * nothing was paid for. That is the whole griefing bound on invalid requests:
   * a signature that is expired, replayed, malleated or somebody else's costs
   * one RPC round trip, never gas.
   *
   * A request that is valid but would cost more than
   * {@link EVM_RELAYED_INTENT_MAX_COST_WEI} right now is not refused: it is a
   * 503, because the chain did not say no — its fees are briefly high.
   *
   * Anything that is not revert data — a transport failure, a node that is down
   * — propagates untouched, for the reason `estimateWithdrawGas` gives next
   * door: mapping everything here would answer "the chain refused you" to an
   * outage, which is a wrong answer that reads like an actionable one.
   */
  private async preflight(
    chainId: ChainId,
    relayer: `0x${string}`,
    to: `0x${string}`,
    data: `0x${string}`,
  ): Promise<{ gasLimit: bigint; l2BaseFee: bigint | null }> {
    let estimate: bigint;
    try {
      estimate = await this.client(chainId).estimateGas({ account: relayer, to, data, value: 0n });
    } catch (error) {
      const revertData = revertDataOf(error);
      if (revertData === null) {
        throw error;
      }
      const name = evmErrorName(revertData);
      // D-19: the two refusals a person can act on get their own errors.
      if (name === 'ProgramPaused') throw ChainErrors.programPaused({ chainId });
      if (name === 'AddressBlocked') throw ChainErrors.addressBlocked({ chainId });
      throw SettlementErrors.relayedIntentRefused({ reason: name });
    }

    // On Nitro the estimate is execution + the L1 posting cost in L2 gas. The
    // ceiling is about the contract's shape, so it applies to execution only;
    // the L1 half is a fee, bounded by cost below. Off Nitro, L1 is 0 and this
    // is the check it always was.
    const { l1Gas, l2BaseFee } = await estimateL1Gas(this.client(chainId), {
      account: relayer,
      to,
      data,
    });
    // The two reads are a moment apart. When the L1 part read back at or above
    // the whole estimate, the split is unknown: nothing is held against the
    // execution ceiling, and the whole estimate is budgeted for execution below
    // so the transaction is never sent with no execution gas at all.
    const split = estimate > l1Gas;
    const execution = split ? estimate - l1Gas : 0n;

    // 20 % margin, for the reason the builder gives at its own: an estimate is a
    // floor rather than an answer, and a transaction that runs out of gas has
    // still spent it.
    const executionLimit = (execution * 12n) / 10n;
    if (executionLimit > EVM_RELAYED_INTENT_MAX_GAS) {
      throw SettlementErrors.relayedIntentRefused({
        reason:
          `the call estimates at ${executionLimit} gas, above the ${EVM_RELAYED_INTENT_MAX_GAS} ` +
          `ceiling a relayed request is allowed to cost`,
      });
    }
    // The limit sent covers both halves, each with the margin.
    const gasLimit = (((split ? execution : estimate) + l1Gas) * 12n) / 10n;
    if (exceedsCostCap(gasLimit, l2BaseFee, EVM_RELAYED_INTENT_MAX_COST_WEI)) {
      this.logger.warn(
        `a relayed request on ${chainId} was deferred: ${gasLimit} gas (L1 ${l1Gas}) at ` +
          `${l2BaseFee} wei is above the ${EVM_RELAYED_INTENT_MAX_COST_WEI} wei cap`,
      );
      throw SettlementErrors.relayedIntentUnavailable({ feeSpike: true });
    }
    return { gasLimit, l2BaseFee };
  }

  /**
   * The reading door, applying EIP-55 **strictly** — the same check every other
   * entry point on this chain got after the adapter's own was measured
   * repairing a broken checksum. Here a repaired address would be a call
   * encoded for somebody nobody verified, paid for by the platform.
   */
  private parse(account: AccountId): { chainId: ChainId; address: `0x${string}` } {
    const parsed = parseAccountId(account);
    if (!this.deployments.has(parsed.chainId)) {
      throw ChainErrors.unsupportedChain({ chainId: parsed.chainId });
    }
    if (!isAddress(parsed.address, { strict: true })) {
      throw ChainErrors.invalidAddress({ chainId: parsed.chainId, address: parsed.address });
    }
    return { chainId: parsed.chainId, address: getAddress(parsed.address) };
  }

  private signature(value: string): `0x${string}` {
    if (!SECP256K1_SIGNATURE_RE.test(value)) {
      throw SettlementErrors.relayedIntentMalformed({
        reason: 'the signature is not 65 bytes of hex (r || s || v)',
      });
    }
    return value as `0x${string}`;
  }

  /**
   * Every amount argument on `AssayEscrow` is a `uint64`, and these arrive from
   * an HTTP body rather than from `Money`.
   *
   * Out of range would otherwise throw inside viem's encoder with a message
   * about a word, at a point where the caller can no longer tell which field it
   * was — and a 400 naming the field is what a console can act on.
   */
  private address(value: string, field: string): `0x${string}` {
    if (!isAddress(value, { strict: false })) {
      throw SettlementErrors.relayedIntentMalformed({
        reason: `${field} is not a 20-byte address`,
      });
    }
    return getAddress(value);
  }

  private uint64(value: bigint, field: string): bigint {
    if (value < 0n || value > MAX_UINT64) {
      throw SettlementErrors.relayedIntentMalformed({
        reason: `${field} does not fit the uint64 the escrow declares`,
      });
    }
    return value;
  }

  private deployment(chainId: ChainId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
    return deployment;
  }

  private client(chainId: ChainId): EvmRelayedIntentClient {
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
