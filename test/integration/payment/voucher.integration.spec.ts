import { randomBytes, randomUUID } from 'node:crypto';

import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import {
  PaymentIntentCallClass,
  PaymentIntentStatus,
  PaymentRail,
} from '@modules/payment/ports/payment.types';

import { expectErrorCodeAsync } from '../../unit/helpers/expect-error-code';
import { VoucherTestContext, createVoucherTestContext } from '../helpers/voucher-test-context';

/** Postgres `check_violation` — distinct from `23505`, the unique-index one. */
const CHECK_VIOLATION_CODE = '23514';

/**
 * Vouchers and replay protection against real infrastructure.
 *
 * The unit suite decides *what* is rejected. This one proves the things that
 * are not properties of our code at all, and that a fake would assert into
 * existence without testing:
 *
 * 1. `uq_payment_intents_account_voucher_seq` refuses a replay **on its own**
 *    — there is no fast path left to remove, unlike v1's Redis reservation.
 * 2. A genuine `UPDATE … RETURNING`-style compare-and-swap in Postgres
 *    arbitrates two concurrent inserts for the same `(account, seq)`.
 * 3. `EscrowSeqService.wasIssued` is a real read of `buyer_escrows.next_seq`,
 *    not a mock that always answers `true`.
 */
describe('Voucher redemption — real Postgres, real Redis', () => {
  let context: VoucherTestContext;

  beforeAll(async () => {
    context = await createVoucherTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    // A fresh tenant per test, and the agent starts funded — securing the price
    // opens a real ledger hold, so an unfunded agent fails for the wrong reason.
    await context.fund(context.payer, 100_000_000n);
  });

  describe('the happy path', () => {
    it('redeems, records the seq and holds the price in the ledger', async () => {
      const before = await context.available(context.payer);
      const input = context.voucherFor();

      const intent = await context.vouchers.redeem(input);

      expect(intent.status).toBe(PaymentIntentStatus.FUNDS_SECURED);
      expect(intent.rail).toBe(PaymentRail.RAIL_B_VOUCHER);
      expect(intent.voucherSeq).toBe(input.signed.voucher.seq);
      expect(intent.holdId).not.toBeNull();

      // The money actually moved buckets — this is the point of redeeming.
      expect(await context.available(context.payer)).toBe(before - 1_000_000n);
      expect(await context.held(context.payer)).toBe(1_000_000n);
    });
  });

  describe('a seq the backend never issued', () => {
    it('refuses it — a real read of buyer_escrows, not a mock that says yes', async () => {
      // `voucher-test-context.ts` seeds `next_seq` far ahead of anything
      // `voucherFor()` mints locally, so a seq past even that ceiling is one
      // `EscrowSeqService.wasIssued` genuinely has never heard of.
      const input = context.voucherFor({ seq: '999999999' });

      await expectErrorCodeAsync(
        () => context.vouchers.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH,
      );
    });

    it('refuses it when the account has no escrow at all', async () => {
      const unopened = context.voucherFor();
      await context.dataSource.query(`DELETE FROM "buyer_escrows" WHERE "account_id" = $1`, [
        context.payer,
      ]);

      await expectErrorCodeAsync(
        () => context.vouchers.redeem(unopened),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH,
      );
    });
  });

  describe('replay', () => {
    it('refuses the second presentation, from the unique index alone', async () => {
      const input = context.voucherFor();
      await context.vouchers.redeem(input);

      await expectErrorCodeAsync(
        () => context.vouchers.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH,
      );

      // And exactly one intent exists for that seq, so exactly one hold was
      // opened and exactly one charge can follow.
      expect(await countIntentsWithSeq(context.payer, input.signed.voucher.seq)).toBe(1);
    });

    it('refuses a voucher replayed under a different organization', async () => {
      // The seq index is keyed on `agent_account`, not on `organization_id` —
      // were it tenant-scoped, this would succeed once per tenant, and the
      // same on-chain `seq` could be claimed by two different organizations
      // for one buyer's escrow.
      const input = context.voucherFor();
      await context.vouchers.redeem(input);

      await expectErrorCodeAsync(
        () => context.vouchers.redeem({ ...input, organizationId: randomUUID() }),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH,
      );
    });
  });

  describe('two simultaneous requests carrying the same voucher', () => {
    it('lets exactly one through — Postgres arbitrating', async () => {
      const input = context.voucherFor();

      const results = await Promise.allSettled([
        context.vouchers.redeem(input),
        context.vouchers.redeem(input),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason.errorCode).toBe(PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH);

      expect(await countIntentsWithSeq(context.payer, input.signed.voucher.seq)).toBe(1);
      // One hold, not two: the loser never reached the ledger.
      expect(await context.held(context.payer)).toBe(1_000_000n);
    });

    it('lets exactly one of ten through', async () => {
      const input = context.voucherFor();

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => context.vouchers.redeem(input)),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await countIntentsWithSeq(context.payer, input.signed.voucher.seq)).toBe(1);
    });

    it('does not serialise distinct vouchers against each other', async () => {
      const first = context.voucherFor();
      const second = context.voucherFor();

      await Promise.all([context.vouchers.redeem(first), context.vouchers.redeem(second)]);

      expect(await context.held(context.payer)).toBe(2_000_000n);
    });
  });

  describe('the schema refuses what the service would never write', () => {
    it('rejects a rail-B intent with neither a voucher nonce nor a voucher seq', async () => {
      // `trg_payment_intents_rail_b_has_nonce`, widened with sequenced vouchers to accept
      // either field. A rail-B intent with neither is a charge with no replay
      // protection at all, and the trigger makes that unrepresentable rather
      // than merely unwritten.
      await expect(
        context.intents.create({
          organizationId: context.organizationId,
          agentId: context.id('no-seq:agent'),
          agentAccount: context.payer,
          providerId: context.id('no-seq:provider'),
          providerAccount: context.account('no-seq-provider'),
          toolId: context.id('no-seq:tool'),
          rail: PaymentRail.RAIL_B_VOUCHER,
          callId: randomUUID(),
          callClass: PaymentIntentCallClass.PAID,
          price: context.usdc(1_000_000n),
          platformFee: context.usdc(100_000n),
          requestHash: `sha256:${'0'.repeat(64)}`,
          chainId: context.voucherFor().chainId,
        }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION_CODE });
    });

    it('rejects a rail-A intent that carries a voucher seq', async () => {
      await expect(
        context.intents.create({
          organizationId: context.organizationId,
          agentId: context.id('rail-a:agent'),
          agentAccount: context.payer,
          providerId: context.id('rail-a:provider'),
          providerAccount: context.account('rail-a-provider'),
          toolId: context.id('rail-a:tool'),
          rail: PaymentRail.RAIL_A_PER_CALL,
          callId: randomUUID(),
          callClass: PaymentIntentCallClass.PAID,
          price: context.usdc(1_000_000n),
          platformFee: context.usdc(100_000n),
          requestHash: `sha256:${'0'.repeat(64)}`,
          chainId: context.voucherFor().chainId,
          voucherSeq: '1',
        }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION_CODE });
    });

    it('refuses to clear a recorded seq, which would return a spent voucher', async () => {
      // The unique index only covers non-null seqs, so nulling the column
      // drops the row out of it and the voucher becomes spendable again.
      // `trg_payment_intents_voucher_seq_immutable` is the only thing between
      // a retention job and a re-openable authorization.
      const input = context.voucherFor();
      const intent = await context.vouchers.redeem(input);

      await expect(
        context.dataSource.query('UPDATE payment_intents SET voucher_seq = NULL WHERE id = $1', [
          intent.id,
        ]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION_CODE });

      await expect(
        context.dataSource.query(
          'UPDATE payment_intents SET voucher_seq = $2::bigint WHERE id = $1',
          [intent.id, '999'],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION_CODE });

      // Still spent.
      await expectErrorCodeAsync(
        () => context.vouchers.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH,
      );
    });

    it('still lets an ordinary status transition through', async () => {
      // `BEFORE UPDATE OF voucher_seq` fires only when the column is in the
      // SET list, so the immutability trigger must not touch the state machine.
      const intent = await context.vouchers.redeem(context.voucherFor());

      const moved = await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.FUNDS_SECURED,
        PaymentIntentStatus.PROVIDER_EXECUTING,
      );

      expect(moved.status).toBe(PaymentIntentStatus.PROVIDER_EXECUTING);
      expect(moved.voucherSeq).toBe(intent.voucherSeq);
    });

    it('still lets a legacy (pre-sequenced-voucher) rail-B intent be expired', async () => {
      // The reason the rail-B rule is a BEFORE INSERT trigger and not a CHECK.
      //
      // A CHECK is re-evaluated on every UPDATE, so a rail-B row written before
      // this migration — no nonce and no seq, because there was no voucher path
      // yet — would become unmodifiable, and the expiry sweep could never move
      // it to EXPIRED. Its ledger hold would then sit open until the 24-hour
      // backstop. A guard that strands an agent's money is not a guard.
      //
      // Disabling the trigger is the only way to manufacture such a row now,
      // which is itself the proof that no new one can appear.
      const legacyId = randomUUID();
      await context.dataSource.query(
        `ALTER TABLE payment_intents DISABLE TRIGGER trg_payment_intents_rail_b_has_nonce`,
      );
      try {
        await context.dataSource.query(
          `INSERT INTO payment_intents (
             id, organization_id, status, agent_id, agent_account, provider_id,
             provider_account, tool_id, rail, call_id, call_class, asset_id, decimals,
             price_amount, provider_amount, platform_fee, request_hash, chain_id, expires_at
           ) VALUES ($1, $2, 'CREATED', $3, 'a', $4, 'p', $5, 'RAIL_B_VOUCHER', $8, 'PAID',
             $6, 6, 10, 10, 0, 'sha256:legacy', $7, now() - interval '1 hour')`,
          [
            legacyId,
            context.organizationId,
            context.id('legacy:agent'),
            context.id('legacy:provider'),
            context.id('legacy:tool'),
            context.usdc(1n).asset,
            context.voucherFor().chainId,
            randomUUID(),
          ],
        );
      } finally {
        await context.dataSource.query(
          `ALTER TABLE payment_intents ENABLE TRIGGER trg_payment_intents_rail_b_has_nonce`,
        );
      }

      const expired = await context.intents.transition(
        context.organizationId,
        legacyId,
        PaymentIntentStatus.CREATED,
        PaymentIntentStatus.EXPIRED,
        { reason: 'legacy row, swept' },
      );

      expect(expired.status).toBe(PaymentIntentStatus.EXPIRED);
      expect(expired.voucherNonce).toBeNull();
      expect(expired.voucherSeq).toBeNull();
    });

    it('refuses two intents sharing a nonce, whatever else differs (v1 rows, kept for history)', async () => {
      const nonce = randomBytes(16).toString('hex');
      const create = (label: string, organizationId: string) =>
        context.intents.create({
          organizationId,
          agentId: context.id(`${label}:agent`),
          agentAccount: context.account(`${label}-agent`),
          providerId: context.id(`${label}:provider`),
          providerAccount: context.account(`${label}-provider`),
          toolId: context.id(`${label}:tool`),
          rail: PaymentRail.RAIL_B_VOUCHER,
          callId: randomUUID(),
          callClass: PaymentIntentCallClass.PAID,
          price: context.usdc(7n),
          platformFee: context.usdc(0n),
          requestHash: `sha256:${'1'.repeat(64)}`,
          chainId: context.voucherFor().chainId,
          voucherNonce: nonce,
        });

      await create('shared-nonce-a', context.organizationId);

      // Different tenant, different agent, different tool, different request —
      // and still refused, because the nonce is the same.
      await expectErrorCodeAsync(
        () => create('shared-nonce-b', randomUUID()),
        PaymentErrorCode.PAYMENT_VOUCHER_NONCE_REPLAYED,
      );
    });

    it('refuses two intents sharing an account and seq, whatever else differs', async () => {
      const create = (label: string, seq: string) =>
        context.intents.create({
          organizationId: context.organizationId,
          agentId: context.id(`${label}:agent`),
          agentAccount: context.payer,
          providerId: context.id(`${label}:provider`),
          providerAccount: context.account(`${label}-provider`),
          toolId: context.id(`${label}:tool`),
          rail: PaymentRail.RAIL_B_VOUCHER,
          callId: randomUUID(),
          callClass: PaymentIntentCallClass.PAID,
          price: context.usdc(7n),
          platformFee: context.usdc(0n),
          requestHash: `sha256:${'2'.repeat(64)}`,
          chainId: context.voucherFor().chainId,
          voucherSeq: seq,
        });

      await create('shared-seq-a', '42');

      await expectErrorCodeAsync(
        () => create('shared-seq-b', '42'),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH,
      );
    });
  });

  describe('a spent voucher stays spent across a failure', () => {
    it('keeps the seq recorded when securing the funds fails', async () => {
      // A brand-new agent with no balance: the intent is written, the hold is
      // refused, and the voucher must not become spendable again.
      const broke = await createUnfundedContext();
      try {
        const input = broke.voucherFor();

        await expect(broke.vouchers.redeem(input)).rejects.toBeDefined();

        await expectErrorCodeAsync(
          () => broke.vouchers.redeem(input),
          PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH,
        );
      } finally {
        await broke.close();
      }
    });
  });

  async function countIntentsWithSeq(account: string, seq: string): Promise<number> {
    const rows = await context.dataSource.query<{ count: string }[]>(
      'SELECT count(*)::text AS count FROM payment_intents WHERE agent_account = $1 AND voucher_seq = $2::bigint',
      [account, seq],
    );
    return parseInt(rows[0].count, 10);
  }

  async function createUnfundedContext(): Promise<VoucherTestContext> {
    const fresh = await createVoucherTestContext();
    await fresh.reset();
    return fresh;
  }
});
