import { DataSource } from 'typeorm';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  DuePaymentIntent,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { MCP_VERIFICATION_DEADLINE_REASON } from '@modules/mcp/constants/mcp.constants';
import {
  PAYMENT_INTENT_REDEMPTION_MARGIN_SECONDS,
  PAYMENT_INTENT_VERDICT_DEADLINE_LATEST_SECONDS,
  PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS,
} from '@modules/payment/constants/payment-intent.constants';
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  REDEEM_GRACE_SECONDS,
} from '@modules/payment/constants/voucher-redemption.constants';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';
import { PaymentIntentExpiryService } from '@modules/payment/services/payment-intent-expiry.service';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * The deadline on verdicts (no-platform-debt design, step 4, closes A13).
 *
 * A rail-B voucher can be redeemed only until `expiresAt + skew + grace`, and
 * only a SETTLED intent is redeemed. A verdict that arrives after that — the
 * judge queue backed up, the worker down — used to leave a served call whose
 * voucher could no longer be collected. A rail-B intent still `VERIFYING` at
 * `expiresAt + PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS` is now settled as
 * served and unverified, the same rule as a failed verification enqueue, so
 * the redemption job still has time to collect it.
 */

const NOW = new Date('2026-10-16T12:00:00Z');
const PRICE = MoneyUtil.of(1_000_000n, ASSET_IDS.USDC_SOLANA_DEVNET, 6);

function due(id: string): DuePaymentIntent {
  return {
    organizationId: 'org-1',
    id,
    status: PaymentIntentStatus.VERIFYING,
    holdId: `hold-${id}`,
  };
}

/** A `PaymentIntentService` with the one property that matters here: the status CAS. */
function build(candidates: DuePaymentIntent[]) {
  const status = new Map(candidates.map((row) => [row.id, PaymentIntentStatus.VERIFYING]));
  const repo = {
    findDueForExpiry: jest.fn().mockResolvedValue([]),
    findDueForHoldBackstop: jest.fn().mockResolvedValue([]),
    findExpiredWithUnreleasedHold: jest.fn().mockResolvedValue([]),
    findDueForVerdictDeadline: jest.fn(async () =>
      candidates.filter((row) => status.get(row.id) === PaymentIntentStatus.VERIFYING),
    ),
    findDueForWriteOff: jest.fn().mockResolvedValue([]),
  };
  const intents = {
    findById: jest.fn(async (_org: string, id: string) => ({
      id,
      status: status.get(id),
      price: PRICE,
      rail: PaymentRail.RAIL_B_VOUCHER,
    })),
    resolve: jest.fn(
      async (
        _org: string,
        id: string,
        from: PaymentIntentStatus,
        to: PaymentIntentStatus,
        _context: unknown,
      ) => {
        if (status.get(id) !== from) {
          throw PaymentErrors.invalidStateTransition({ intentId: id, from, to });
        }
        status.set(id, to);
        return { id, status: to };
      },
    ),
    transition: jest.fn(),
    releaseHold: jest.fn(),
  };
  const service = new PaymentIntentExpiryService(repo as never, intents as never);
  return { service, repo, intents, status };
}

describe('PaymentIntentExpiryService — the deadline on verdicts', () => {
  it('settles an overdue rail-B VERIFYING intent as served, at its own price, with the new reason', async () => {
    const { service, repo, intents, status } = build([due('late-1')]);

    const report = await service.sweep(NOW);

    expect(repo.findDueForVerdictDeadline).toHaveBeenCalledWith(
      NOW,
      PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS,
      expect.any(Number),
    );
    expect(intents.resolve).toHaveBeenCalledWith(
      'org-1',
      'late-1',
      PaymentIntentStatus.VERIFYING,
      PaymentIntentStatus.SETTLED,
      { reason: MCP_VERIFICATION_DEADLINE_REASON, settledAmount: PRICE },
    );
    expect(status.get('late-1')).toBe(PaymentIntentStatus.SETTLED);
    expect(report).toMatchObject({ verdictDeadlineSettled: 1, failed: 0 });
    // Settling never releases: the hold stays open for the redemption job.
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('is idempotent: a second pass settles nothing more', async () => {
    const { service, intents } = build([due('late-1')]);

    await service.sweep(NOW);
    const second = await service.sweep(NOW);

    expect(intents.resolve).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ verdictDeadlineSettled: 0, failed: 0 });
  });

  it('a verdict that lands after the sweep loses the compare-and-swap — no double settle', async () => {
    const { service, intents } = build([due('late-1')]);
    await service.sweep(NOW);

    await expect(
      intents.resolve(
        'org-1',
        'late-1',
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.REFUNDED,
        {},
      ),
    ).rejects.toMatchObject({ errorCode: 'PAYMENT_INVALID_STATE_TRANSITION' });
  });

  it('a verdict that lands first wins, and the sweep counts its lost race without failing the pass', async () => {
    const { service, intents, status } = build([due('late-1'), due('late-2')]);
    // The worker resolves late-1 between the sweep's read and its write.
    intents.findById.mockImplementationOnce(async (_org: string, id: string) => {
      status.set(id, PaymentIntentStatus.REFUNDED);
      return {
        id,
        status: PaymentIntentStatus.REFUNDED,
        price: PRICE,
        rail: PaymentRail.RAIL_B_VOUCHER,
      };
    });

    const report = await service.sweep(NOW);

    expect(status.get('late-1')).toBe(PaymentIntentStatus.REFUNDED);
    expect(status.get('late-2')).toBe(PaymentIntentStatus.SETTLED);
    expect(report).toMatchObject({ verdictDeadlineSettled: 1, failed: 0 });
  });

  it('leaves the redemption job time to collect before the chain refuses the voucher', () => {
    // The EVM contract redeems until expiresAt + grace with NO skew
    // (X402Escrow.sol:784); the sweep settles at expiresAt + deadline, and the
    // redemption cron runs every minute.
    const redeemableFor = REDEEM_GRACE_SECONDS - PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS;
    expect(PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS).toBe(900);
    expect(redeemableFor).toBeGreaterThanOrEqual(10 * 60);
  });

  it('M3: the latest a voucher is handed to redemption is derived from the chain deadline', () => {
    // No skew on the chain side: the old 120 + 1,800 - 300 left 180 s, not 300.
    expect(PAYMENT_INTENT_VERDICT_DEADLINE_LATEST_SECONDS).toBe(
      REDEEM_GRACE_SECONDS - PAYMENT_INTENT_REDEMPTION_MARGIN_SECONDS,
    );
    expect(REDEEM_GRACE_SECONDS - PAYMENT_INTENT_VERDICT_DEADLINE_LATEST_SECONDS).toBe(600);
    expect(PAYMENT_INTENT_VERDICT_DEADLINE_LATEST_SECONDS).toBeGreaterThan(
      PAYMENT_INTENT_VERDICT_DEADLINE_SECONDS,
    );
    expect(CLOCK_SKEW_TOLERANCE_SECONDS).toBeGreaterThan(0); // and not part of the bound
  });
});

describe('PaymentIntentRepository.findDueForVerdictDeadline — the query', () => {
  async function rendered(): Promise<{ sql: string; params: Record<string, unknown> }> {
    const dataSource = new DataSource({ type: 'postgres', entities: [PaymentIntentEntity] });
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    const repo = new PaymentIntentRepository(dataSource);
    let captured = { sql: '', params: {} as Record<string, unknown> };
    const original = dataSource.createQueryBuilder.bind(dataSource);
    jest.spyOn(dataSource, 'createQueryBuilder').mockImplementation(((...args: unknown[]) => {
      const qb = (original as (...a: unknown[]) => any)(...args);
      qb.getRawMany = async function () {
        captured = { sql: this.getQuery(), params: this.getParameters() };
        return [];
      };
      return qb;
    }) as never);
    jest
      .spyOn(repo, 'createQueryBuilder')
      .mockImplementation(((alias: string) =>
        dataSource.createQueryBuilder(PaymentIntentEntity, alias)) as never);

    await repo.findDueForVerdictDeadline(NOW, 900, 50);
    return captured;
  }

  it('selects rail-B VERIFYING intents with a redeemable voucher, past expiresAt + the deadline', async () => {
    const { sql, params } = await rendered();
    const flat = sql.replace(/\s+/g, ' ');

    expect(Object.values(params)).toEqual(
      expect.arrayContaining([
        PaymentIntentStatus.VERIFYING,
        PaymentRail.RAIL_B_VOUCHER,
        new Date(NOW.getTime() - 900_000),
      ]),
    );
    expect(flat).toMatch(/"intent"\."status" = /);
    expect(flat).toMatch(/"intent"\."rail" = /);
    expect(flat).toMatch(/"intent"\."expires_at" < /);
    expect(flat).toMatch(/"intent"\."hold_released_at" IS NULL/);
    expect(flat).toMatch(/"intent"\."voucher_seq" IS NOT NULL/);
    expect(flat).toMatch(/"intent"\."voucher_signature" IS NOT NULL/);
    expect(flat).toMatch(/LIMIT 50/);
  });

  it('M3: has no upper bound — a row past the redeemable latest settles into buyer debt', async () => {
    // `PaymentIntentService.resolve` lapses it; leaving it to the 24 h backstop
    // released the hold of a call that was served.
    const { sql } = await rendered();
    const flat = sql.replace(/\s+/g, ' ');

    expect(flat).not.toMatch(/"intent"\."expires_at" > /);
  });

  it('skips a row whose verification already computed a REFUND or VOID outcome (L6)', async () => {
    const { sql } = await rendered();
    const flat = sql.replace(/\s+/g, ' ');

    expect(flat).toMatch(
      /NOT EXISTS \(SELECT 1 FROM verification_records vr WHERE vr\.intent_id = "?intent"?\."?id"? AND vr\.settlement_outcome IS NOT NULL AND vr\.settlement_outcome <> 'SETTLE'\)/,
    );
  });
});

describe('PaymentIntentExpiryService — buyer debt write-off (design step 10)', () => {
  function writeOffBuild(candidates: DuePaymentIntent[], lastError: string | null) {
    const order: string[] = [];
    const repo = {
      findDueForExpiry: jest.fn().mockResolvedValue([]),
      findDueForHoldBackstop: jest.fn().mockResolvedValue([]),
      findExpiredWithUnreleasedHold: jest.fn().mockResolvedValue([]),
      findDueForVerdictDeadline: jest.fn().mockResolvedValue([]),
      findDueForWriteOff: jest.fn().mockResolvedValue(candidates),
      findOneBy: jest.fn().mockResolvedValue({ redemptionLastError: lastError }),
      markWrittenOff: jest.fn(async () => {
        order.push('mark');
        return true;
      }),
    };
    const intents = {
      findById: jest.fn(async (_org: string, id: string) => ({
        id,
        agentAccount: 'eip155:46630:0xbuyer',
        providerId: 'provider-1',
        price: PRICE,
      })),
      releaseHold: jest.fn(async () => {
        order.push('release');
        return true;
      }),
    };
    const alerts = { emit: jest.fn().mockResolvedValue(undefined) };
    const service = new PaymentIntentExpiryService(repo as never, intents as never, alerts);
    return { service, repo, intents, alerts, order };
  }

  it('asks for debts lapsed more than 30 days ago', async () => {
    const { service, repo } = writeOffBuild([], null);
    await service.sweep(NOW);
    expect(repo.findDueForWriteOff).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 30 * 24 * 3_600_000),
      expect.any(Number),
    );
  });

  it('records uncollected:<cause> BEFORE releasing the hold, credits nobody, and warns', async () => {
    const { service, repo, intents, alerts, order } = writeOffBuild(
      [{ ...due('debt-1'), status: PaymentIntentStatus.SETTLED }],
      'DelegateIsRevoked',
    );

    const report = await service.sweep(NOW);

    expect(repo.markWrittenOff).toHaveBeenCalledWith(
      'org-1',
      'debt-1',
      'uncollected:DelegateIsRevoked',
    );
    expect(intents.releaseHold).toHaveBeenCalledWith({
      organizationId: 'org-1',
      id: 'debt-1',
      holdId: 'hold-debt-1',
    });
    expect(order).toEqual(['mark', 'release']);
    expect(report).toMatchObject({ debtsWrittenOff: 1, failed: 0 });
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'voucher_debt_written_off' }),
    );
  });

  it('a write-off retried after a crash keeps a single uncollected: prefix', async () => {
    const { service, repo } = writeOffBuild(
      [{ ...due('debt-1'), status: PaymentIntentStatus.SETTLED }],
      'uncollected:VoucherExpired',
    );
    await service.sweep(NOW);
    expect(repo.markWrittenOff).toHaveBeenCalledWith(
      'org-1',
      'debt-1',
      'uncollected:VoucherExpired',
    );
  });
});
