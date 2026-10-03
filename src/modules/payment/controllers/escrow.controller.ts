import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { GetNextSeqResponseDto } from '../dto/get-next-seq.dto';
import { EscrowSeqService } from '../services/escrow-seq.service';

@ApiTags('Escrow')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('escrow')
export class EscrowController {
  constructor(private readonly seqs: EscrowSeqService) {}

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
   */
  @Get('next-seq')
  @ApiOperation({ summary: 'Issue the next voucher sequence number for this account' })
  @ApiResponse({
    status: 200,
    description: 'The issued sequence number',
    type: GetNextSeqResponseDto,
  })
  @ApiResponse({ status: 409, description: 'No escrow is open for this account' })
  async nextSeq(@CurrentSession() session: McpSession): Promise<GetNextSeqResponseDto> {
    const next = await this.seqs.allocate(session.organizationId, session.agentAccount);

    return {
      seq: next.seq,
      payTo: next.escrowPda,
      escrowTokenAccount: next.escrowTokenAccount,
    };
  }
}
