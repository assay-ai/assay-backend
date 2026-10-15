import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  OutstandingDebt,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { AccountId, AssetId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { VOUCHER_MAX_TTL_SECONDS } from '../constants/voucher.constants';
import { PaymentErrors } from '../errors/payment.errors';
import { SignedVoucher } from '../ports/voucher.types';
import { EscrowSeqService } from './escrow-seq.service';
import { VoucherService, writeOffAt } from './voucher.service';

/** One open debt, as the routes report it. */
export interface BuyerDebtView {
  readonly intentId: string;
  readonly payer: string;
  readonly amount: { readonly amount: string; readonly asset: string; readonly decimals: number };
  readonly providerId: string | null;
  readonly toolId: string;
  readonly cause: string | null;
  readonly lapsedAt: string;
  readonly writeOffAt: string;
  readonly createdAt: string;
}

/** The replacement voucher for one debt, unsigned, every field chosen. */
export interface DebtVoucherIntent {
  readonly debt: BuyerDebtView;
  readonly voucher: Voucher;
  readonly signers?: readonly string[];
  readonly delegate?: string | null;
  readonly typedData: Record<string, unknown> | null;
}

/**
 * Settling buyer debt (no-platform-debt design, step 10).
 *
 * A debt is a served paid call whose voucher lapsed for a reason that is not
 * the provider's (`VoucherRedemptionService.lapse`): the buyer's hold is still
 * open and nobody is paid. The buyer settles it the way it pays any call — by
 * signing a voucher — so there is nothing new to learn and nothing new on
 * chain:
 *
 * 1. `GET /escrow/debts` lists the open debts.
 * 2. `POST /escrow/debts/:id/voucher-intent` allocates a fresh `seq` and
 *    answers the replacement voucher: the SAME payer, escrow, provider,
 *    amount and `requestHash` as the served call, every field chosen (plus the
 *    EIP-712 request for a wallet on eip155).
 * 3. `POST /escrow/debts/:id/voucher` takes it back signed — by the payer's
 *    own key (the console's wallet) or by a delegate bound to the calling
 *    agent credential — checks it with the admission rules
 *    (`VoucherService.verifyReplacement`), and swaps it onto the intent
 *    (`PaymentIntentRepository.replaceLapsedVoucher`). The redemption job then
 *    collects it from the buyer's escrow like any other voucher, and the
 *    provider is credited out of it.
 *
 * Nothing here moves money or credits anyone. A debt not settled within
 * `BUYER_DEBT_WRITE_OFF_DAYS` is written off by the expiry sweep.
 */
@Injectable()
export class BuyerDebtService {
  private readonly logger = new Logger(BuyerDebtService.name);

  constructor(
    private readonly payments: PaymentIntentRepository,
    private readonly vouchers: VoucherService,
    private readonly seqs: EscrowSeqService,
    private readonly chains: ChainAdapterRegistry,
    @Inject(ESCROW_BALANCE_READER) private readonly escrow: EscrowBalanceReaderPort,
    @Inject(TOOL_CATALOGUE) private readonly tools: ToolCataloguePort,
  ) {}

  /** The open debts of the session's payer account or organization, oldest first. */
  async list(session: McpSession): Promise<BuyerDebtView[]> {
    const debts = await this.payments.findOutstandingDebts(
      session.organizationId,
      session.agentAccount,
    );
    return debts.map(toView);
  }

  /** Step 2: the replacement voucher to sign for `intentId`, with a fresh seq. */
  async voucherIntent(session: McpSession, intentId: string): Promise<DebtVoucherIntent> {
    const debt = await this.ownDebt(session, intentId);
    const asset = debt.assetId as AssetId;
    const reading = await this.escrow.read(session.agentAccount, asset);
    const { seq } = await this.seqs.allocate(
      session.organizationId,
      session.agentAccount,
      reading ? reading.seqHigh : null,
    );
    const { escrowPda } = await this.escrow.escrowAddresses(session.agentAccount, asset);
    const now = Math.floor(Date.now() / 1000);
    const voucher: Voucher = {
      payer: session.agentAccount,
      payTo: escrowPda,
      provider: debt.providerAccount as AccountId,
      amount: MoneyUtil.of(debt.priceAmount, asset, debt.decimals),
      resource: await this.resourceOf(debt),
      requestHash: debt.requestHash,
      seq,
      issuedAt: now,
      expiresAt: now + VOUCHER_MAX_TTL_SECONDS,
    };
    const adapter = this.chains.resolve(debt.chainId as ChainId);
    const eip155 = (debt.chainId as string).startsWith('eip155:');
    return {
      debt: toView(debt),
      voucher,
      ...(eip155
        ? { signers: ['payer', 'delegate'], delegate: session.delegateAccount ?? null }
        : {}),
      typedData: adapter.voucherTypedData
        ? (adapter.voucherTypedData(voucher) as unknown as Record<string, unknown>)
        : null,
    };
  }

  /**
   * Step 3: accepts the signed replacement for `intentId` and reopens the
   * call to the redemption queue. Refused, with nothing changed, unless it is
   * exactly the voucher step 2 described (a fresh, issued seq) and the payer
   * or a live delegate signed it.
   */
  async settle(
    session: McpSession,
    intentId: string,
    signed: SignedVoucher,
  ): Promise<{ intentId: string; seq: string; remainingDebts: number }> {
    const debt = await this.ownDebt(session, intentId);
    const asset = debt.assetId as AssetId;
    const chainId = debt.chainId as ChainId;
    const reading = await this.escrow.read(session.agentAccount, asset);
    const { escrowPda } = await this.escrow.escrowAddresses(session.agentAccount, asset);
    const resource = await this.resourceOf(debt);

    const delegate = await this.vouchers.verifyReplacement({
      organizationId: session.organizationId,
      signed,
      chainId,
      payer: session.agentAccount,
      escrowPda,
      providerAccount: debt.providerAccount as AccountId,
      resource,
      price: MoneyUtil.of(debt.priceAmount, asset, debt.decimals),
      requestHash: debt.requestHash,
      boundDelegate: session.delegateAccount ?? null,
      escrow: reading,
    });

    const { voucher, signature } = signed;
    const seq = BigInt(voucher.seq);
    const replaced = await this.payments.replaceLapsedVoucher(
      debt.organizationId,
      debt.id,
      session.agentAccount,
      {
        seq: voucher.seq,
        signature,
        issuedAt: voucher.issuedAt,
        delegate,
        expiresAt: new Date(voucher.expiresAt * 1000),
        resourceHash: this.chains.resolve(chainId).voucherResourceHash(voucher.resource),
      },
      (open) => {
        if (open.nextSeq !== null && seq >= open.nextSeq) {
          throw PaymentErrors.voucherSeqMismatch({
            account: session.agentAccount,
            actual: voucher.seq,
          });
        }
        if (open.maxSeq !== null && seq <= open.maxSeq) {
          throw PaymentErrors.voucherSeqStale({
            account: session.agentAccount,
            actual: voucher.seq,
          });
        }
      },
    );
    if (!replaced) {
      throw PaymentErrors.debtNotFound({ intentId });
    }

    this.logger.log(
      `Debt ${intentId} of ${session.agentAccount}: replacement voucher seq ${voucher.seq} ` +
        `accepted; the redemption job collects it from the buyer's escrow.`,
    );
    const remaining = await this.payments.findOutstandingDebts(
      session.organizationId,
      session.agentAccount,
    );
    return { intentId, seq: voucher.seq, remainingDebts: remaining.length };
  }

  /** The session payer's own open debt, or `PAYMENT_DEBT_NOT_FOUND`. */
  private async ownDebt(session: McpSession, intentId: string): Promise<OutstandingDebt> {
    const debts = await this.payments.findOutstandingDebts(
      session.organizationId,
      session.agentAccount,
      200,
    );
    const debt = debts.find((candidate) => candidate.id === intentId);
    // Only the payer account's own escrow can pay it: a debt of another wallet
    // of the organization is listed, but settled from that wallet's session.
    if (
      !debt ||
      debt.agentAccount !== session.agentAccount ||
      !debt.providerAccount ||
      chainIdOf(debt.agentAccount as AccountId) !== session.chainId
    ) {
      throw PaymentErrors.debtNotFound({ intentId });
    }
    return debt;
  }

  /** The resource string the served call's voucher bound: `/mcp/tools/<tool name>`. */
  private async resourceOf(debt: OutstandingDebt): Promise<string> {
    const tool = await this.tools.findTool(debt.toolId);
    if (!tool) {
      throw PaymentErrors.debtNotFound({ intentId: debt.id });
    }
    return `/mcp/tools/${tool.name}`;
  }
}

function toView(debt: OutstandingDebt): BuyerDebtView {
  return {
    intentId: debt.id,
    payer: debt.agentAccount,
    amount: { amount: debt.priceAmount, asset: debt.assetId, decimals: debt.decimals },
    providerId: debt.providerId,
    toolId: debt.toolId,
    cause: debt.cause,
    lapsedAt: new Date(debt.lapsedAt).toISOString(),
    writeOffAt: writeOffAt(debt.lapsedAt).toISOString(),
    createdAt: new Date(debt.createdAt).toISOString(),
  };
}
