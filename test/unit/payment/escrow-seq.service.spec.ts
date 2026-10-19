import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { VOUCHER_MAX_SEQ_GAP } from '@modules/payment/constants/escrow-seq.constants';
import { EscrowSeqService } from '@modules/payment/services/escrow-seq.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { noBlocks } from '../helpers/blocklist';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT: AccountId = toAccountId(
  CHAIN_IDS.SOLANA_DEVNET,
  'BuyerAccount111111111111111111111111111111',
);

/**
 * The two addresses the mirror row holds, chosen to be **unmistakable for each
 * other**. A fixture where both carried the same value — or two values that
 * differ only in a suffix — would let the pair be swapped and still pass, which
 * is how the swap survived until now.
 */
const ESCROW_ACCOUNT_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:TheEscrowAccountItself11111';
const ESCROW_ASSET_ACCOUNT_ID =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:WhereTheBalanceActuallySits';

function buildService(
  allocated: {
    seq: string;
    escrowAccountId: string;
    escrowAssetAccountId: string;
  } | null,
) {
  const escrows = {
    allocateSeq: jest.fn().mockResolvedValue(allocated),
    bumpNextSeqTo: jest.fn().mockResolvedValue(0),
    rewindNextSeq: jest.fn().mockResolvedValue(null),
    // The counter as it stands before allocating: the seq about to be handed out.
    peekNextSeq: jest.fn().mockResolvedValue(allocated ? BigInt(allocated.seq) : null),
  };
  const cache = { get: jest.fn(), set: jest.fn() };

  return {
    escrows,
    service: new EscrowSeqService(escrows as never, cache as never, noBlocks()),
  };
}

describe('EscrowSeqService.allocate', () => {
  /**
   * The multichain rename of the two columns this reads turned an identity copy
   * into a translation between two same-typed string fields. Nothing pinned it:
   * swapping the pair left the whole suite green.
   *
   * The consequence is the worst placement available. `GET /escrow/next-seq`
   * hands the buyer the address they sign as the voucher's `pay_to`; a swapped
   * pair means the buyer signs the escrow's **asset account** as `pay_to`, the
   * platform serves the call, and `redeem_voucher` refuses it on chain minutes
   * later — money held, call served, nothing collected. That is precisely the
   * failure `buyer-escrow.repository.ts` spends a paragraph warning about two
   * functions away.
   */
  it('answers with the escrow account as pay_to and the asset account as the balance holder', async () => {
    const { service } = buildService({
      seq: '7',
      escrowAccountId: ESCROW_ACCOUNT_ID,
      escrowAssetAccountId: ESCROW_ASSET_ACCOUNT_ID,
    });

    const next = await service.allocate(ORGANIZATION_ID, ACCOUNT);

    // Field by field, and both directions: `toEqual` alone would pass a swap
    // if the two fixtures were ever made equal.
    expect(next.seq).toBe('7');
    expect(next.escrowPda).toBe(ESCROW_ACCOUNT_ID);
    expect(next.escrowTokenAccount).toBe(ESCROW_ASSET_ACCOUNT_ID);
    expect(next.escrowPda).not.toBe(ESCROW_ASSET_ACCOUNT_ID);
    expect(next.escrowTokenAccount).not.toBe(ESCROW_ACCOUNT_ID);
  });

  describe('against the chain’s own high-water mark', () => {
    // Lean v3 admits `seq > seq_high` and nothing else, so a number at or below
    // the chain's is dead on arrival — refused AFTER the call it paid for was
    // served. The chain is the authority; `next_seq` is only our record of it.
    const allocated = {
      seq: '8',
      escrowAccountId: ESCROW_ACCOUNT_ID,
      escrowAssetAccountId: ESCROW_ASSET_ACCOUNT_ID,
    };

    it('raises next_seq past seq_high BEFORE allocating', async () => {
      const { service, escrows } = buildService(allocated);

      await service.allocate(ORGANIZATION_ID, ACCOUNT, 7n);

      expect(escrows.bumpNextSeqTo).toHaveBeenCalledWith(ORGANIZATION_ID, ACCOUNT, 8n);
      expect(escrows.bumpNextSeqTo.mock.invocationCallOrder[0]).toBeLessThan(
        escrows.allocateSeq.mock.invocationCallOrder[0],
      );
    });

    it('does not touch next_seq when the chain has not been read', async () => {
      const { service, escrows } = buildService(allocated);

      await service.allocate(ORGANIZATION_ID, ACCOUNT);

      expect(escrows.bumpNextSeqTo).not.toHaveBeenCalled();
    });
  });

  describe('the chain’s seq jump cap (AssayEscrow.MAX_SEQ_GAP)', () => {
    const GAP = BigInt(VOUCHER_MAX_SEQ_GAP);
    const SEQ_HIGH = 7n;
    const at = (seq: bigint) => ({
      seq: seq.toString(),
      escrowAccountId: ESCROW_ACCOUNT_ID,
      escrowAssetAccountId: ESCROW_ASSET_ACCOUNT_ID,
    });

    it('issues a seq exactly MAX_SEQ_GAP above the chain’s seqHigh', async () => {
      const { service } = buildService(at(SEQ_HIGH + GAP));

      await expect(service.allocate(ORGANIZATION_ID, ACCOUNT, SEQ_HIGH)).resolves.toMatchObject({
        seq: (SEQ_HIGH + GAP).toString(),
      });
    });

    it('refuses one above it when the rewind cannot help, BEFORE allocating', async () => {
      // `rewindNextSeq` moved nothing: every seq up to the counter is recorded.
      const { service, escrows } = buildService(at(SEQ_HIGH + GAP + 1n));

      await expectErrorCodeAsync(
        () => service.allocate(ORGANIZATION_ID, ACCOUNT, SEQ_HIGH),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_GAP_TOO_LARGE,
      );
      expect(escrows.rewindNextSeq).toHaveBeenCalledWith(ORGANIZATION_ID, ACCOUNT, SEQ_HIGH, GAP);
      expect(escrows.allocateSeq).not.toHaveBeenCalled();
    });

    it('rewinds a counter past the gap, then allocates from the rewound value (S2-2)', async () => {
      const { service, escrows } = buildService(at(SEQ_HIGH + 1n));
      escrows.peekNextSeq
        .mockResolvedValueOnce(SEQ_HIGH + GAP + 1n)
        .mockResolvedValueOnce(SEQ_HIGH + 1n);
      escrows.rewindNextSeq.mockResolvedValue(SEQ_HIGH + 1n);

      await expect(service.allocate(ORGANIZATION_ID, ACCOUNT, SEQ_HIGH)).resolves.toMatchObject({
        seq: (SEQ_HIGH + 1n).toString(),
      });
      expect(escrows.rewindNextSeq.mock.invocationCallOrder[0]).toBeLessThan(
        escrows.allocateSeq.mock.invocationCallOrder[0],
      );
    });

    it('does not rewind a counter within the gap', async () => {
      const { service, escrows } = buildService(at(SEQ_HIGH + GAP));
      await service.allocate(ORGANIZATION_ID, ACCOUNT, SEQ_HIGH);
      expect(escrows.rewindNextSeq).not.toHaveBeenCalled();
    });

    it('refuses an allocated seq over the cap even when the pre-check passed (a concurrent allocation)', async () => {
      const { service, escrows } = buildService(at(SEQ_HIGH + GAP + 1n));
      escrows.peekNextSeq.mockResolvedValue(SEQ_HIGH + GAP);

      await expectErrorCodeAsync(
        () => service.allocate(ORGANIZATION_ID, ACCOUNT, SEQ_HIGH),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_GAP_TOO_LARGE,
      );
    });

    it('applies no cap when the chain has not been read', async () => {
      const { service, escrows } = buildService(at(SEQ_HIGH + GAP + 1n));

      await expect(service.allocate(ORGANIZATION_ID, ACCOUNT)).resolves.toBeDefined();
      expect(escrows.peekNextSeq).not.toHaveBeenCalled();
    });
  });

  it('refuses with PAYMENT_ESCROW_NOT_OPEN when the buyer has no mirror row', async () => {
    const { service } = buildService(null);

    await expectErrorCodeAsync(
      () => service.allocate(ORGANIZATION_ID, ACCOUNT),
      PaymentErrorCode.PAYMENT_ESCROW_NOT_OPEN,
    );
  });

  it('allocates against the caller’s own organization and account', async () => {
    const { service, escrows } = buildService({
      seq: '1',
      escrowAccountId: ESCROW_ACCOUNT_ID,
      escrowAssetAccountId: ESCROW_ASSET_ACCOUNT_ID,
    });

    await service.allocate(ORGANIZATION_ID, ACCOUNT);

    expect(escrows.allocateSeq).toHaveBeenCalledWith(ORGANIZATION_ID, ACCOUNT);
  });
});

/**
 * The review's S2-2 PoC (`seq-lockout.poc.ts`), kept as a regression test. It
 * used to show every later allocation refused for ever once unpaid
 * allocations ran the counter past `MAX_SEQ_GAP`. Now the allocator recovers.
 *
 * The in-memory repository models `rewindNextSeq` the way the SQL does:
 * `max(chainSeqHigh, highest recorded seq) + 1`, lowering only.
 */
describe('regression: seq-gap lockout (review S2-2)', () => {
  function fakeRepo(recorded: bigint[] = []) {
    let nextSeq = 1n;
    return {
      get next() {
        return nextSeq;
      },
      allocateSeq: async () => {
        const seq = nextSeq;
        nextSeq += 1n;
        return { seq: seq.toString(), escrowAccountId: 'e', escrowAssetAccountId: 'a' };
      },
      bumpNextSeqTo: async (_o: string, _a: string, to: bigint) => {
        if (nextSeq < to) {
          nextSeq = to;
          return 1;
        }
        return 0;
      },
      peekNextSeq: async () => nextSeq,
      rewindNextSeq: async (_o: string, _a: string, seqHigh: bigint, gap: bigint) => {
        if (nextSeq - seqHigh <= gap) return null;
        const highest = recorded.reduce((a, b) => (b > a ? b : a), 0n);
        const target = (highest > seqHigh ? highest : seqHigh) + 1n;
        if (nextSeq > target) {
          nextSeq = target;
          return target;
        }
        return null;
      },
      jump: (n: bigint) => {
        nextSeq += n;
      },
    };
  }

  it('recovers after 1,000,001 unpaid allocations instead of refusing for ever', async () => {
    const repo = fakeRepo();
    const svc = new EscrowSeqService(
      repo as never,
      { get: jest.fn(), set: jest.fn() } as never,
      noBlocks(),
    );
    // 1,000,001 unpaid allocations through the controller path (fast-forwarded).
    await svc.allocate(ORGANIZATION_ID, ACCOUNT);
    repo.jump(1_000_000n);
    expect(repo.next).toBe(1_000_002n);

    // The chain never moved (seqHigh 0). Every later allocation succeeds.
    const seqs: string[] = [];
    for (let i = 0; i < 3; i++) seqs.push((await svc.allocate(ORGANIZATION_ID, ACCOUNT, 0n)).seq);
    expect(seqs).toEqual(['1', '2', '3']);
  });

  it('never goes back to or below a recorded seq, nor the chain’s seqHigh', async () => {
    const repo = fakeRepo([40n, 41n]);
    const svc = new EscrowSeqService(
      repo as never,
      { get: jest.fn(), set: jest.fn() } as never,
      noBlocks(),
    );
    repo.jump(2_000_000n);

    await expect(svc.allocate(ORGANIZATION_ID, ACCOUNT, 10n)).resolves.toMatchObject({ seq: '42' });

    const chainAhead = fakeRepo([40n]);
    const svc2 = new EscrowSeqService(
      chainAhead as never,
      { get: jest.fn(), set: jest.fn() } as never,
      noBlocks(),
    );
    chainAhead.jump(3_000_000n);
    await expect(svc2.allocate(ORGANIZATION_ID, ACCOUNT, 500n)).resolves.toMatchObject({
      seq: '501',
    });
  });
});
