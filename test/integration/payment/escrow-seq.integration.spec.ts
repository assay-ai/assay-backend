import { randomUUID } from 'node:crypto';

import { AccountId } from '@modules/chains/ports/caip.types';
import {
  ESCROW_SEQ_ALERTS,
  VOUCHER_MAX_IN_FLIGHT,
} from '@modules/payment/constants/escrow-seq.constants';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { AlertSeverity } from '@shared/alerting';

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
      maxInFlight: VOUCHER_MAX_IN_FLIGHT,
      inFlight: 0,
    });
  });

  it('refuses at the 512th unsettled call and admits again once one settles', async () => {
    await context.openEscrow(context.organizationId, account);
    await context.seedOpenIntent(context.organizationId, account, 1n);
    await context.setNextSeq(account, 513n);
    await context.clearGapCache(account);

    await expectErrorCodeAsync(
      () => context.service.allocate(context.organizationId, account),
      PaymentErrorCode.PAYMENT_TOO_MANY_IN_FLIGHT,
    );

    await context.settleIntent(account, 1n);
    await context.clearGapCache(account);

    await expect(context.service.allocate(context.organizationId, account)).resolves.toMatchObject({
      seq: '513',
    });
  });

  it('does not burn a sequence number on a refused call', async () => {
    // The gate is checked before the allocation. Allocating and then refusing
    // would walk `next_seq` forward on every 429, so a client retrying in a
    // loop would widen the very gap that caused the refusal.
    await context.openEscrow(context.organizationId, account);
    await context.seedOpenIntent(context.organizationId, account, 1n);
    await context.setNextSeq(account, 513n);
    await context.clearGapCache(account);

    await context.service.allocate(context.organizationId, account).catch(() => undefined);

    expect(await context.readNextSeq(account)).toBe(513n);
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

  describe('one escrow per account, enforced by the database', () => {
    it('refuses a second row for the same account, whatever asset it names', async () => {
      // The chain has ONE `["escrow", buyer]` PDA per buyer, carrying one
      // `seq_high` and one `[u64; 128]` bitmap, whose token account is the ATA
      // for the single mint `Config` fixes. A key of `(account_id, asset_id)`
      // would let two rows model that one PDA — and then `allocateSeq`'s UPDATE
      // matches both, advances both counters, and returns whichever row
      // Postgres produced first. The buyer would sign a voucher naming one
      // row's escrow PDA with a `seq` drawn from the other row's counter, and
      // `realignTo` could never converge because it would fight itself across
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

  it('counts an escrow the account shares with a second organization', async () => {
    // The escrow PDA is derived from the pubkey alone, so a second tenant's
    // in-flight voucher occupies the same on-chain window. Scoping the pending
    // minimum by organization would under-report the gap and let the platform
    // issue past the chain's `VoucherSeqJump` bound.
    const otherOrganization = context.organizationId;
    await context.openEscrow(otherOrganization, account);
    await context.seedOpenIntent(otherOrganization, account, 1n);
    await context.clearGapCache(account);

    await context.reset();
    await context.setNextSeq(account, 513n);
    await context.clearGapCache(account);

    await expectErrorCodeAsync(
      () => context.service.allocate(otherOrganization, account),
      PaymentErrorCode.PAYMENT_TOO_MANY_IN_FLIGHT,
    );
  });

  describe('realigning to a chain that has moved past the allocator', () => {
    it('raises next_seq past seq_high and pages a human once', async () => {
      await context.openEscrow(context.organizationId, account);

      const realigned = await context.service.realignTo(context.organizationId, account, 900n);

      expect(realigned).toBe(true);
      expect(await context.readNextSeq(account)).toBe(901n);
      expect(context.alerts.emitted).toHaveLength(1);
      expect(context.alerts.emitted[0]).toMatchObject({
        name: ESCROW_SEQ_ALERTS.REALIGNED,
        severity: AlertSeverity.WARN,
        dedupeKey: account,
      });
    });

    it('is a no-op, and silent, when the allocator is already ahead', async () => {
      await context.openEscrow(context.organizationId, account);
      await context.setNextSeq(account, 1_000n);

      expect(await context.service.realignTo(context.organizationId, account, 900n)).toBe(false);
      expect(await context.readNextSeq(account)).toBe(1_000n);
      expect(context.alerts.emitted).toHaveLength(0);
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
