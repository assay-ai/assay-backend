import { randomUUID } from 'node:crypto';

import { AccountId } from '@modules/chains/ports/caip.types';
import { VOUCHER_MAX_SEQ_GAP } from '@modules/payment/constants/escrow-seq.constants';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';

import {
  EscrowSeqTestContext,
  createEscrowSeqTestContext,
} from '../helpers/escrow-seq-test-context';
import { expectErrorCodeAsync } from '../../unit/helpers/expect-error-code';

/**
 * The `seq` allocator, against the two systems it actually relies on.
 *
 * Nothing here can be proved by an in-memory fake. The uniqueness of fifty
 * concurrent allocations is a property of Postgres taking a row lock for an
 * `UPDATE … RETURNING`; the refusal to lower `next_seq` is a trigger; the
 * in-flight gate reads a `MIN` over a partial index and caches it in a real
 * Redis. A double-issued `seq` is not a slow test — it is a voucher that dies
 * on chain with `VoucherAlreadyRedeemed` after the call has been served and the
 * buyer's money held.
 */
describe('EscrowSeqService against Postgres', () => {
  let context: EscrowSeqTestContext;
  let account: AccountId;

  beforeAll(async () => {
    context = await createEscrowSeqTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    // A fresh account per test: the escrow table is keyed on the account and
    // never on the organization, so reusing one across tests would share an
    // allocator between them.
    account = context.account(`escrow-seq-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await context.clearGapCache(account);
  });

  it('refuses to issue anything for an account with no escrow', async () => {
    await expectErrorCodeAsync(
      () => context.service.allocate(context.organizationId, account),
      PaymentErrorCode.PAYMENT_ESCROW_NOT_OPEN,
    );
  });

  it('never issues the same sequence number twice under concurrency', async () => {
    await context.openEscrow(context.organizationId, account);

    const issued = await Promise.all(
      Array.from({ length: 50 }, () => context.service.allocate(context.organizationId, account)),
    );

    const seqs = issued.map((next) => next.seq);
    expect(new Set(seqs).size).toBe(50);
    expect(seqs.map(Number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_unused, index) => index + 1),
    );
  });

  it('answers with the escrow addresses the voucher has to name', async () => {
    await context.openEscrow(context.organizationId, account);

    const next = await context.service.allocate(context.organizationId, account);

    expect(next).toMatchObject({
      seq: '1',
      escrowPda: `escrow-${account.slice(-8)}`,
      escrowTokenAccount: `escrow-ata-${account.slice(-8)}`,
    });
  });

  it('admits a call however far the allocator is ahead of the oldest unsettled voucher', async () => {
    // The program admits `seq > seq_high` and nothing else, so the old 512-call
    // in-flight ceiling has nothing left to protect and must not refuse.
    await context.openEscrow(context.organizationId, account);
    await context.seedOpenIntent(context.organizationId, account, 1n);
    await context.setNextSeq(account, 513n);
    await context.clearGapCache(account);

    await expect(context.service.allocate(context.organizationId, account)).resolves.toMatchObject({
      seq: '513',
    });
    expect(await context.readNextSeq(account)).toBe(514n);
  });

  it('an issued but unused sequence number does not wedge the window', async () => {
    // `oldest_pending_seq` is computed from `payment_intents`, not from the
    // allocator, so a seq that never becomes a voucher never enters the MIN.
    // Holes are free: the chain's bitmap is keyed on distance, not density.
    await context.openEscrow(context.organizationId, account);
    for (let index = 0; index < 600; index += 1) {
      await context.service.allocate(context.organizationId, account);
    }

    await expect(context.service.allocate(context.organizationId, account)).resolves.toMatchObject({
      seq: '601',
    });
  });

  it('refuses to lower next_seq, at the database', async () => {
    await context.openEscrow(context.organizationId, account);
    await context.setNextSeq(account, 100n);

    await expect(context.setNextSeq(account, 99n)).rejects.toThrow(/next_seq may only increase/);
  });

  /**
   * REGRESSION (review S2-2): unpaid allocations could push `next_seq` more
   * than `MAX_SEQ_GAP` past the chain's `seqHigh`, after which every voucher
   * issuance was refused for ever. The allocator now rewinds and recovers.
   */
  describe('recovering a counter past the chain’s seq gap', () => {
    const GAP = BigInt(VOUCHER_MAX_SEQ_GAP);

    it('rewinds to just above the highest recorded seq and allocates from there', async () => {
      await context.openEscrow(context.organizationId, account);
      for (const seq of [1n, 2n, 7n]) {
        await context.seedOpenIntent(context.organizationId, account, seq);
      }
      await context.setNextSeq(account, GAP + 2n);

      await expect(
        context.service.allocate(context.organizationId, account, 0n),
      ).resolves.toMatchObject({ seq: '8' });
      expect(await context.readNextSeq(account)).toBe(9n);
    });

    it('rewinds to just above the chain’s seqHigh when that is higher', async () => {
      await context.openEscrow(context.organizationId, account);
      await context.seedOpenIntent(context.organizationId, account, 3n);
      await context.setNextSeq(account, 50n + GAP + 1n);

      await expect(
        context.service.allocate(context.organizationId, account, 50n),
      ).resolves.toMatchObject({ seq: '51' });
    });

    it('counts a recorded seq of another organization sharing the account', async () => {
      await context.openEscrow(context.organizationId, account);
      await context.seedOpenIntent(randomUUID(), account, 20n);
      await context.setNextSeq(account, GAP + 5n);

      await expect(
        context.service.allocate(context.organizationId, account, 0n),
      ).resolves.toMatchObject({ seq: '21' });
    });

    it('hands out unique seqs above every recorded one under concurrency', async () => {
      await context.openEscrow(context.organizationId, account);
      await context.seedOpenIntent(context.organizationId, account, 10n);
      await context.setNextSeq(account, GAP + 100n);

      const issued = await Promise.all(
        Array.from({ length: 20 }, () =>
          context.service.allocate(context.organizationId, account, 0n).then(
            (next) => BigInt(next.seq),
            () => null,
          ),
        ),
      );
      const seqs = issued.filter((seq): seq is bigint => seq !== null);
      expect(seqs.length).toBeGreaterThan(0);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs.every((seq) => seq > 10n && seq <= GAP)).toBe(true);
    });

    it('the database still refuses a rewind to or below a recorded seq, even inside the gate', async () => {
      await context.openEscrow(context.organizationId, account);
      await context.seedOpenIntent(context.organizationId, account, 9n);
      await context.setNextSeq(account, 100n);

      const lower = (to: bigint) =>
        context.dataSource.transaction(async (manager) => {
          await manager.query(`SELECT set_config('assay.seq_rewind', 'on', true)`);
          await manager.query(
            `UPDATE "buyer_escrows" SET "next_seq" = $2::bigint WHERE "account_id" = $1`,
            [account, to.toString()],
          );
        });

      await expect(lower(9n)).rejects.toThrow(/next_seq may only increase/);
      await expect(lower(10n)).resolves.toBeUndefined();
      expect(await context.readNextSeq(account)).toBe(10n);
    });

    it('does not rewind a counter within the gap', async () => {
      await context.openEscrow(context.organizationId, account);
      await context.setNextSeq(account, GAP + 1n);

      await expect(
        context.service.allocate(context.organizationId, account, 1n),
      ).resolves.toMatchObject({ seq: (GAP + 1n).toString() });
    });
  });

  describe('one escrow per account, enforced by the database', () => {
    it('refuses a second row for the same account, whatever asset it names', async () => {
      // The chain has ONE `["escrow", buyer]` PDA per buyer, carrying one
      // `seq_high` and one `[u64; 128]` bitmap, whose token account is the ATA
      // for the single mint `Config` fixes. A key of `(account_id, asset_id)`
      // would let two rows model that one PDA — and then `allocateSeq`'s UPDATE
      // matches both, advances both counters, and returns whichever row
      // Postgres produced first. The buyer would sign a voucher naming one
      // row's escrow PDA with a `seq` drawn from the other row's counter, and
      // the chain-ahead raise could never converge because it would fight itself across
      // the two.
      await context.openEscrow(context.organizationId, account);

      await expect(
        context.insertEscrowRow(context.organizationId, account, 'solana:mainnet/token:OTHER'),
      ).rejects.toThrow(/uq_buyer_escrows_account/);
    });

    it('refuses a second row even under a different organization', async () => {
      // The escrow is derived from the pubkey alone, so tenancy cannot make a
      // second allocator legitimate either.
      await context.openEscrow(context.organizationId, account);
      const otherOrganization = randomUUID();

      await expect(
        context.insertEscrowRow(otherOrganization, account, 'solana:mainnet/token:OTHER'),
      ).rejects.toThrow(/uq_buyer_escrows_account/);
    });
  });

  it('re-opening an escrow does not reset the allocator', async () => {
    // `upsertOpened` is idempotent for the addresses and must not be for the
    // counter: an upsert that reset `next_seq` to 1 would re-issue every number
    // already spent.
    await context.openEscrow(context.organizationId, account);
    await context.service.allocate(context.organizationId, account);
    await context.service.allocate(context.organizationId, account);

    await context.openEscrow(context.organizationId, account);

    await expect(context.service.allocate(context.organizationId, account)).resolves.toMatchObject({
      seq: '3',
    });
  });

  describe('raising the allocator past a chain that has moved ahead of it', () => {
    it('allocates past seq_high when the chain is ahead', async () => {
      await context.openEscrow(context.organizationId, account);

      await expect(
        context.service.allocate(context.organizationId, account, 900n),
      ).resolves.toMatchObject({ seq: '901' });
      expect(await context.readNextSeq(account)).toBe(902n);
    });

    it('never rewinds the allocator when it is already ahead of the chain', async () => {
      await context.openEscrow(context.organizationId, account);
      await context.setNextSeq(account, 1_000n);

      await expect(
        context.service.allocate(context.organizationId, account, 900n),
      ).resolves.toMatchObject({ seq: '1000' });
      expect(await context.readNextSeq(account)).toBe(1_001n);
    });
  });

  describe('the pending-seq cache', () => {
    it('serves the same answer with Redis flushed — it is a cache, not a store', async () => {
      await context.openEscrow(context.organizationId, account);
      await context.seedOpenIntent(context.organizationId, account, 1n);

      const warm = await context.service.oldestPendingSeq(account);
      await context.clearGapCache(account);
      const cold = await context.service.oldestPendingSeq(account);

      expect(warm).toBe(1n);
      expect(cold).toBe(1n);
    });

    it('remembers "nothing pending" rather than recomputing it on every call', async () => {
      await context.openEscrow(context.organizationId, account);

      expect(await context.service.oldestPendingSeq(account)).toBeNull();
      // Written to the cache as a sentinel: `null` and a cache miss are
      // indistinguishable through `CacheService.get`, and treating the idle
      // majority of buyers as a miss would recompute the MIN on every call.
      await context.seedOpenIntent(context.organizationId, account, 5n);
      expect(await context.service.oldestPendingSeq(account)).toBeNull();

      await context.clearGapCache(account);
      expect(await context.service.oldestPendingSeq(account)).toBe(5n);
    });
  });
});
