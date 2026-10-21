import { Inject, Injectable } from '@nestjs/common';

import { assertRailOffered, chainMetadata } from '@modules/chains/chain-metadata';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { RedisDemoRateLimiter } from '@modules/mcp/services/redis-demo-rate-limiter.service';

import { NEXT_SEQ_RATE_LIMITER, NEXT_SEQ_RATE_LIMITS } from '../constants/escrow-seq.constants';
import { PaymentErrors } from '../errors/payment.errors';
import { PaymentRail, railName } from '../ports/payment.types';
import { EscrowSeqService, NextSeq } from './escrow-seq.service';

/**
 * `GET /escrow/next-seq`, throttled and given the chain's `seqHigh` (review
 * S2-2).
 *
 * Each call advances the payer's counter, and unbounded calls could push it
 * more than `MAX_SEQ_GAP` past the chain, where `AssayEscrow` refuses every
 * voucher. So each agent credential gets {@link NEXT_SEQ_RATE_LIMITS} (the
 * public demo's sliding window, which fails closed), and the allocation reads
 * the escrow like the MCP path does: that applies the gap cap and rewinds a
 * counter that is already past it. An account with no escrow on chain is
 * refused `PAYMENT_ESCROW_NOT_OPEN` (409) before anything is allocated.
 */
@Injectable()
export class NextSeqService {
  constructor(
    private readonly seqs: EscrowSeqService,
    @Inject(ESCROW_BALANCE_READER) private readonly escrow: EscrowBalanceReaderPort,
    @Inject(NEXT_SEQ_RATE_LIMITER) private readonly rateLimiter: RedisDemoRateLimiter,
  ) {}

  async issue(
    organizationId: string,
    account: AccountId,
    chainId: ChainId,
    credentialId: string,
  ): Promise<NextSeq> {
    // A seq only builds a rail-B voucher: refuse a chain without rail B before
    // the rate limiter and the escrow read, as `VoucherService.record` does.
    assertRailOffered(chainId, railName(PaymentRail.RAIL_B_VOUCHER));
    const rate = await this.rateLimiter.take(`credential:${credentialId}`);
    if (!rate.allowed) {
      throw PaymentErrors.nextSeqRateLimited({
        reason: rate.reason,
        limit: NEXT_SEQ_RATE_LIMITS.perAddressPerWindow,
        windowSeconds: NEXT_SEQ_RATE_LIMITS.windowMs / 1000,
      });
    }

    const asset = chainMetadata(chainId).settlementAsset as AssetId;
    const reading = await this.escrow.read(account, asset);
    // No escrow on chain: a voucher over this seq could never be redeemed, so
    // hand none out and do not advance the counter (spec SEC-16, BUG-SEC-02).
    // An eip155 buyer may have a mirror row before funding, which is why the
    // allocator alone does not refuse it.
    if (!reading) throw PaymentErrors.escrowNotOpen({ account });
    return this.seqs.allocate(organizationId, account, reading.seqHigh);
  }
}
