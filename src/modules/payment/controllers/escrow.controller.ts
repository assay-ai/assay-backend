import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Voucher } from '@modules/chains/ports/x402.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import {
  DebtVoucherIntentBodyDto,
  DebtVoucherIntentResponseDto,
  GetBuyerDebtsResponseDto,
  SettleDebtBodyDto,
  SettleDebtResponseDto,
} from '../dto/buyer-debt.dto';
import { GetNextSeqResponseDto } from '../dto/get-next-seq.dto';
import { BuyerDebtService } from '../services/buyer-debt.service';
import { NextSeqService } from '../services/next-seq.service';

const DEBT_NOT_FOUND_DESCRIPTION =
  'PAYMENT_DEBT_NOT_FOUND — no debt with this id this session can settle: settled already, ' +
  'owed by another wallet (settle it from that wallet’s session), or another agent’s call ' +
  'signed by this agent’s delegate (settle it with the payer wallet).';
const DEBT_PENDING_DESCRIPTION =
  'PAYMENT_DEBT_REPLACEMENT_PENDING — a replacement for this debt is being collected already; ' +
  'PAYMENT_DEBT_NOT_YET_REPLACEABLE — its original voucher is still inside its on-chain ' +
  'redemption window: settle it after `replaceableAt`.';

@ApiTags('Escrow')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('escrow')
export class EscrowController {
  constructor(
    private readonly nextSeqs: NextSeqService,
    private readonly debts: BuyerDebtService,
  ) {}

  /**
   * `GET /escrow/debts` — the payer's BUYER DEBTS that refuse paid calls:
   * served paid calls whose vouchers lapsed (the buyer revoked or tightened,
   * the escrow ran short, an outage or a late verdict outlived the voucher).
   * Paid calls are refused (`PAYMENT_DEBT_OUTSTANDING`) until every one is
   * collected; free calls work. Each has a `state`: `OPEN` (sign it),
   * `REPLACING` (signed, being collected — nothing to do), `WRITTEN_OFF` (not
   * settled within 30 days: the hold was released and the provider was not
   * paid, but paid calls stay refused until it is signed — review-buyer-debt
   * H1).
   *
   * The payer account's debts and the organization's, so a console sees every
   * debt that blocks its agents. Open to the person's session and the agent's.
   */
  @Get('debts')
  @ApiOperation({ summary: "The payer's open debts: served calls still to be paid" })
  @ApiResponse({ status: 200, type: GetBuyerDebtsResponseDto })
  async listDebts(@CurrentSession() session: McpSession): Promise<GetBuyerDebtsResponseDto> {
    return { account: session.agentAccount, debts: await this.debts.list(session) };
  }

  /**
   * `POST /escrow/debts/:intentId/voucher-intent` — the replacement voucher to
   * sign for one debt: the served call's own payer, escrow, provider, amount
   * and `requestHash`, a fresh `seq`, and a five-minute life. A `POST` because
   * it allocates the seq (an unused one costs nothing: holes are free), and
   * throttled with `GET /escrow/next-seq`'s per-credential budget.
   */
  @Post('debts/:intentId/voucher-intent')
  @ApiOperation({ summary: 'Build the replacement voucher that settles one debt' })
  @ApiResponse({ status: 201, type: DebtVoucherIntentResponseDto })
  @ApiResponse({ status: 404, description: DEBT_NOT_FOUND_DESCRIPTION })
  @ApiResponse({ status: 409, description: DEBT_PENDING_DESCRIPTION })
  @ApiResponse({ status: 429, description: 'PAYMENT_NEXT_SEQ_RATE_LIMITED' })
  async debtVoucherIntent(
    @CurrentSession() session: McpSession,
    @Param('intentId', new ParseUUIDPipe()) intentId: string,
    @Body() body?: DebtVoucherIntentBodyDto,
  ): Promise<DebtVoucherIntentResponseDto> {
    const intent = await this.debts.voucherIntent(session, intentId, body?.resource ?? null);
    return {
      debt: intent.debt,
      voucher: intent.voucher as unknown as Record<string, unknown>,
      ...(intent.signers
        ? { signers: [...intent.signers], delegate: intent.delegate ?? null }
        : {}),
      typedData: intent.typedData,
    };
  }

  /**
   * `POST /escrow/debts/:intentId/voucher` — settle one debt with the signed
   * replacement. Signed by the payer's own key (the console's wallet) or by
   * the delegate bound to the calling agent credential (for that agent's own
   * call, within its spend policy). Checked like any voucher, under the
   * payer's lock with the same window, pause and seq checks; once accepted the
   * debt is `REPLACING`, the redemption job collects it from the buyer's
   * escrow and the provider is credited out of it — never by the platform.
   * Paid calls resume once it is collected.
   */
  @Post('debts/:intentId/voucher')
  @ApiOperation({ summary: 'Settle one debt with a signed replacement voucher' })
  @ApiResponse({ status: 201, type: SettleDebtResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'PAYMENT_VOUCHER_MALFORMED / _BINDING_MISMATCH / PAYMENT_REQUEST_HASH_MISMATCH; ' +
      'PAYMENT_VOUCHER_SIGNATURE_INVALID (not signed by the payer or its bound delegate)',
  })
  @ApiResponse({ status: 404, description: DEBT_NOT_FOUND_DESCRIPTION })
  @ApiResponse({
    status: 402,
    description: 'Re-signing a written-off debt: the escrow cannot cover it any more',
  })
  @ApiResponse({
    status: 409,
    description:
      'PAYMENT_VOUCHER_SEQ_* — ask for a new voucher-intent and sign again; ' +
      'PAYMENT_DEBT_REPLACEMENT_PENDING; PAYMENT_DEBT_NOT_YET_REPLACEABLE (retry after ' +
      '`replaceableAt`); PAYMENT_DEBT_REPLACEMENT_REFUSED (the debt changed meanwhile: list ' +
      'it again); PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED / ' +
      'PAYMENT_VOUCHER_DELEGATE_LIMIT_EXCEEDED (the window is full: retry later)',
  })
  @ApiResponse({ status: 503, description: 'PAYMENT_VOUCHER_ADMISSION_PAUSED — retry shortly' })
  async settleDebt(
    @CurrentSession() session: McpSession,
    @Param('intentId', new ParseUUIDPipe()) intentId: string,
    @Body() body: SettleDebtBodyDto,
  ): Promise<SettleDebtResponseDto> {
    const settled = await this.debts.settle(session, intentId, {
      voucher: body.voucher as unknown as Voucher,
      signature: body.signature,
    });
    return { ...settled, status: 'REPLACING' };
  }

  /**
   * `GET /escrow/next-seq`.
   *
   * Issues the sequence number the client must put in its next voucher, and
   * returns the escrow addresses that voucher's `pay_to` must name. The account
   * is never a request field — it comes off `@CurrentSession()`, for the reason
   * every other session-scoped route gives: a request that could name the
   * account is a request one buyer could point at another buyer's escrow.
   *
   * **The consumer is the AGENT / MCP client, not the console.** Vouchers are
   * signed agent-side; the browser console holds no voucher code at all. So the
   * principal here is an agent credential resolved through `McpSessionPort` —
   * the same one `POST /tool-calls` authenticates — not a Privy console user.
   * Getting that wrong would auth-scope the sequence allocator to a human who
   * never calls it while leaving the agent that does unable to reach it.
   *
   * **A `GET` that writes.** It advances `buyer_escrows.next_seq`, which is not
   * what `GET` promises, and that is deliberate: the route is fixed, the
   * response carries no secret, and every alternative (a `POST`, a reservation
   * with a TTL) makes an unused sequence number into something that has to be
   * cleaned up. An issued-and-unused seq costs nothing — it never becomes a
   * `payment_intents` row, and the chain admits a voucher on `seq > seq_high`
   * alone, so gaps are free and unbounded. `@HttpCacheTTL` is deliberately
   * absent; caching this would hand two calls the same number.
   *
   * **Throttled, and given the chain's `seqHigh` (review S2-2).** Unbounded
   * calls could push the counter more than `MAX_SEQ_GAP` past the chain, where
   * `X402Escrow` refuses every voucher. So each credential gets
   * `NEXT_SEQ_RATE_LIMITS` (a sliding window in Redis that fails closed;
   * see `NextSeqService`), and the allocation reads the escrow like the MCP path does, which
   * applies the gap cap and rewinds a counter that is already past it.
   */
  @Get('next-seq')
  @ApiOperation({ summary: 'Issue the next voucher sequence number for this account' })
  @ApiResponse({
    status: 200,
    description: 'The issued sequence number',
    type: GetNextSeqResponseDto,
  })
  @ApiResponse({ status: 409, description: 'No escrow is open for this account' })
  @ApiResponse({ status: 429, description: 'Too many sequence numbers requested' })
  async nextSeq(@CurrentSession() session: McpSession): Promise<GetNextSeqResponseDto> {
    const next = await this.nextSeqs.issue(
      session.organizationId,
      session.agentAccount,
      session.chainId,
      session.credentialId,
    );

    return {
      seq: next.seq,
      payTo: next.escrowPda,
      escrowTokenAccount: next.escrowTokenAccount,
    };
  }
}
