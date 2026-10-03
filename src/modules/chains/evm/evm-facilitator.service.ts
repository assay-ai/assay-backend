import { Logger } from '@nestjs/common';
import {
  decodeFunctionData,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';

import { ChainErrors } from '../errors/chains.errors';
import { X402_INVALID_REASON } from '../facilitator/facilitator.wire';
import { AccountId, ChainId, parseChainId, toAccountId } from '../ports/caip.types';
import { FacilitatorPort } from '../ports/facilitator.port';
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  TxRef,
  VerifyResponse,
} from '../ports/x402.types';
import { X402_ESCROW_ABI } from './abi/x402.abi';
import { EVM_PAYMENT_SCHEME } from './evm-chain.adapter';
import { EvmDeployment } from './evm.constants';

/**
 * The slice of a viem client this class uses — declared structurally, for the
 * reason `EvmReadClient` gives.
 *
 * `sendRawTransaction` is here and nowhere else in the read path. It
 * broadcasts bytes **somebody else signed**: this class holds no key, so it
 * cannot author a transaction, only relay one whose every field the buyer
 * already committed to. `EvmRelayer` stays the only thing that *signs*.
 */
export interface EvmFacilitatorClient {
  call(args: { account: `0x${string}`; to: `0x${string}`; data: `0x${string}` }): Promise<unknown>;
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
  sendRawTransaction(args: { serializedTransaction: `0x${string}` }): Promise<`0x${string}`>;
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: string } | null>;
}

/**
 * Discriminated by the presence of `reason`, not by a boolean tag: this
 * project compiles without `strictNullChecks`, under which a `true`/`false`
 * literal discriminant does not narrow.
 */
type Verdict =
  | { readonly sender: AccountId; readonly serialized: `0x${string}` }
  | { readonly reason: string };

/**
 * `FacilitatorPort` on `eip155` — the contract-call deposit flow's `/verify`
 * and `/settle`, in process.
 *
 * ## Why in process, when the Solana facilitator is a separate service
 *
 * The SVM facilitator is its own `SERVICE_TYPE` because it **co-signs** as fee
 * payer, and that key must not share an address space with the API. Nothing
 * here signs anything. The buyer signed a complete EIP-1559 transaction — gas,
 * fee caps, nonce and all — and this class checks it and hands the same bytes
 * to a node. There is no secret for a separate process to protect.
 *
 * ## What `verify` checks that `assertPayloadBoundToIntent` does not
 *
 * The adapter binds the bytes to the *intent* (escrow, `depositFor`, buyer,
 * amount). This binds them to the *requirements* and adds the three things only
 * a facilitator can:
 *
 *  - **Who signed it.** `depositFor` pulls from `msg.sender`, so the recovered
 *    sender is who pays, and it must be the buyer being credited.
 *  - **Whether the sender can pay the gas they signed for.** Otherwise the node
 *    refuses the send and the buyer sees a 502 for a problem that is theirs.
 *  - **Whether it would succeed now**, by `eth_call` as the sender. A missing
 *    `approve` is the common failure, and this is where it is caught — before a
 *    reverted transaction spends the buyer's gas.
 */
export class EvmFacilitator implements FacilitatorPort {
  readonly name = 'evm-local';

  private readonly logger = new Logger(EvmFacilitator.name);

  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmFacilitatorClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
  ) {}

  async supports(chainId: ChainId, scheme: string): Promise<boolean> {
    return scheme === EVM_PAYMENT_SCHEME && this.deployments.has(chainId);
  }

  /**
   * There is none. Gas is paid by whoever signed, and
   * `EvmChainAdapter.requiresFeePayer` is `false`, so no caller asks — a
   * caller that does has mistaken this chain for Solana, and a loud refusal is
   * better than an address that would be advertised as a co-signer.
   */
  async getFeePayer(chainId: ChainId): Promise<AccountId> {
    throw ChainErrors.facilitatorUnavailable({
      chainId,
      reason: 'eip155 has no fee payer — gas is paid by the transaction’s signer',
    });
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const verdict = await this.check(payload, requirements);
    return 'reason' in verdict
      ? { isValid: false, invalidReason: verdict.reason }
      : { isValid: true, payer: verdict.sender };
  }

  /**
   * Re-verifies, then broadcasts the buyer's own bytes.
   *
   * Returns as soon as the node accepts them — the same contract the SVM
   * facilitator has. `DepositService.observeOnceLanded` owns "has it landed",
   * and a transaction that reverts on chain is observed as moving nothing.
   *
   * **A retried settle is not a second payment.** The hash is a function of
   * the bytes, so when the node refuses a send ("already known", "nonce too
   * low") the receipt under that hash is the answer: bytes that already landed
   * settled, bytes that did not are a failure. Simulation is deliberately not
   * consulted on that branch — against post-deposit state it would revert.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    const verdict = await this.check(payload, requirements);
    if ('reason' in verdict) {
      const landed = await this.landedWithoutCheck(payload, requirements);
      if (landed) {
        return landed;
      }
      return { success: false, network, errorReason: verdict.reason };
    }

    const client = this.clients.get(network) as EvmFacilitatorClient;
    const hash = keccak256(verdict.serialized) as TxRef;
    try {
      await client.sendRawTransaction({ serializedTransaction: verdict.serialized });
    } catch (error) {
      if (await this.hasReceipt(client, hash)) {
        return { success: true, network, transaction: hash, payer: verdict.sender };
      }
      // The node's reason is not echoed: it can quote the raw transaction.
      this.logger.warn(
        `eth_sendRawTransaction refused ${hash} on ${network}: ${(error as Error).name}`,
      );
      return { success: false, network, errorReason: X402_INVALID_REASON.UNEXPECTED_SETTLE_ERROR };
    }
    return { success: true, network, transaction: hash, payer: verdict.sender };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * The retry case of `settle`: a payload whose checks now fail (its deposit
   * already moved the allowance, so simulation reverts) but whose bytes are
   * mined. Only the structural half is re-checked — the signer and the call —
   * so a stranger's mined transaction cannot be claimed as this settlement.
   */
  private async landedWithoutCheck(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse | null> {
    const structural = await this.check(payload, requirements, { chainState: false });
    if ('reason' in structural) {
      return null;
    }
    const client = this.clients.get(requirements.network) as EvmFacilitatorClient;
    const hash = keccak256(structural.serialized) as TxRef;
    return (await this.hasReceipt(client, hash))
      ? {
          success: true,
          network: requirements.network,
          transaction: hash,
          payer: structural.sender,
        }
      : null;
  }

  private async check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    options: { chainState: boolean } = { chainState: true },
  ): Promise<Verdict> {
    const network = requirements.network;
    const client = this.clients.get(network);
    const deployment = this.deployments.get(network);
    if (payload.network !== network || !client || !deployment) {
      return { reason: X402_INVALID_REASON.INVALID_NETWORK };
    }
    if (payload.scheme !== EVM_PAYMENT_SCHEME || requirements.scheme !== EVM_PAYMENT_SCHEME) {
      return { reason: X402_INVALID_REASON.INVALID_SCHEME };
    }

    const serialized = payload.payload?.transaction;
    if (typeof serialized !== 'string' || !/^0x[0-9a-fA-F]+$/.test(serialized)) {
      return { reason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_TRANSACTION };
    }
    const bytes = serialized as `0x${string}`;

    let tx: ReturnType<typeof parseTransaction>;
    let sender: `0x${string}`;
    try {
      tx = parseTransaction(bytes);
      // Throws on bytes with no signature — an unsigned transaction is not a
      // payment anybody made.
      sender = getAddress(
        await recoverTransactionAddress({ serializedTransaction: bytes as never }),
      );
    } catch {
      return { reason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_TRANSACTION };
    }

    if (
      tx.chainId !== Number(parseChainId(network).reference) ||
      !tx.to ||
      getAddress(tx.to) !== getAddress(deployment.escrow) ||
      !tx.data
    ) {
      return { reason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_TRANSACTION };
    }

    let credited: string;
    let amount: bigint;
    try {
      const call = decodeFunctionData({ abi: X402_ESCROW_ABI, data: tx.data });
      if (call.functionName !== 'depositFor') {
        return { reason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_TRANSACTION };
      }
      [credited, amount] = call.args as readonly [string, bigint];
    } catch {
      return { reason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_TRANSACTION };
    }

    // `payTo` on EVM requirements IS the buyer (`buildPaymentRequirements`).
    if (getAddress(credited) !== getAddress(requirements.payTo)) {
      return { reason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_RECIPIENT };
    }
    if (sender !== getAddress(credited)) {
      return { reason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_SIGNATURE };
    }
    if (amount < BigInt(requirements.amount)) {
      return { reason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_AMOUNT };
    }

    if (options.chainState) {
      const gasCost = (tx.gas ?? 0n) * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n) + (tx.value ?? 0n);
      if ((await client.getBalance({ address: sender })) < gasCost) {
        return { reason: X402_INVALID_REASON.INSUFFICIENT_FUNDS };
      }
      try {
        await client.call({ account: sender, to: getAddress(tx.to), data: tx.data });
      } catch {
        return { reason: X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_SIMULATION };
      }
    }

    return { sender: toAccountId(network, sender), serialized: bytes };
  }

  private async hasReceipt(client: EvmFacilitatorClient, hash: TxRef): Promise<boolean> {
    const receipt = await client
      .getTransactionReceipt({ hash: hash as `0x${string}` })
      .catch(() => null);
    return receipt !== null;
  }
}
