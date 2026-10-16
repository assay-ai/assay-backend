import { NextSeqService } from '@modules/payment/services/next-seq.service';
import { DemoRateDecision } from '@modules/mcp/domain/demo-rate-limit';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * `GET /escrow/next-seq` (review S2-2): throttled per credential, and given the
 * chain's `seqHigh` so the gap cap and the rewind apply on this path too.
 */
describe('NextSeqService.issue (GET /escrow/next-seq)', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const ACCOUNT = toAccountId(
    CHAIN_IDS.ROBINHOOD_TESTNET,
    '0x00000000000000000000000000000000000000aa',
  );
  const issue = (service: NextSeqService) =>
    service.issue(ORG, ACCOUNT, CHAIN_IDS.ROBINHOOD_TESTNET, 'cred-1');

  function build(allowed: boolean, reading: { seqHigh: bigint } | null = { seqHigh: 41n }) {
    const seqs = {
      allocate: jest.fn().mockResolvedValue({
        seq: '42',
        escrowPda: 'pda',
        escrowTokenAccount: 'ata',
      }),
    };
    const escrow = { read: jest.fn().mockResolvedValue(reading) };
    const limiter = {
      take: jest.fn().mockResolvedValue({
        allowed,
        reason: allowed ? DemoRateDecision.ALLOWED : DemoRateDecision.RATE_LIMITED,
        remaining: allowed ? 1 : 0,
      }),
    };
    return {
      seqs,
      escrow,
      limiter,
      service: new NextSeqService(seqs as never, escrow as never, limiter as never),
    };
  }

  it('passes the chain seqHigh to the allocator', async () => {
    const { service, seqs, limiter } = build(true);

    await expect(issue(service)).resolves.toMatchObject({ seq: '42' });
    expect(seqs.allocate).toHaveBeenCalledWith(ORG, ACCOUNT, 41n);
    expect(limiter.take).toHaveBeenCalledWith('credential:cred-1');
  });

  it('passes null when the payer has no escrow on chain', async () => {
    const { service, seqs } = build(true, null);
    await issue(service);
    expect(seqs.allocate).toHaveBeenCalledWith(ORG, ACCOUNT, null);
  });

  it('refuses with 429 over the rate limit, before allocating or reading the chain', async () => {
    const { service, seqs, escrow } = build(false);

    await expectErrorCodeAsync(
      () => issue(service),
      PaymentErrorCode.PAYMENT_NEXT_SEQ_RATE_LIMITED,
    );
    expect(seqs.allocate).not.toHaveBeenCalled();
    expect(escrow.read).not.toHaveBeenCalled();
  });

  it('refuses a chain without rail B (Solana) with 409, before the limiter or the chain', async () => {
    const { service, seqs, escrow, limiter } = build(true);
    const solana = CHAIN_IDS.SOLANA_DEVNET;
    const account = toAccountId(solana, 'AgentAccount1111111111111111111111111111111');

    await expectErrorCodeAsync(
      () => service.issue(ORG, account, solana, 'cred-1'),
      ChainErrorCode.CHAIN_RAIL_NOT_OFFERED,
    );
    expect(limiter.take).not.toHaveBeenCalled();
    expect(escrow.read).not.toHaveBeenCalled();
    expect(seqs.allocate).not.toHaveBeenCalled();
  });
});
