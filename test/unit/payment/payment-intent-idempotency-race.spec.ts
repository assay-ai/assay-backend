import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import {
  CreatePaymentIntentInput,
  PaymentIntentCallClass,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { MoneyUtil } from '@utils/money.util';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { noBlocks } from '../helpers/blocklist';

/**
 * `PaymentIntentService.create` when its insert loses on the idempotency index
 * and the row that won is no longer live by the time it is read back — voided,
 * expired or refunded in between. The key is free then, so the insert is tried
 * once more instead of reporting a collision that is not there (G2.1 review).
 */

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const AGENT =
  `${CHAIN_IDS.SOLANA_DEVNET}:9B2yKCsMTQNbMjJU3wvwhKxjvtpA6TmmbeLtPV4Totpo` as AccountId;

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });
}

class RacingRepository {
  readonly rows = new Map<string, PaymentIntentEntity>();
  inserts = 0;

  constructor(private readonly refusals: Error[]) {}

  insert(row: Partial<PaymentIntentEntity>): Promise<void> {
    this.inserts += 1;
    const refusal = this.refusals.shift();
    if (refusal) return Promise.reject(refusal);
    this.rows.set(row.id as string, row as PaymentIntentEntity);
    return Promise.resolve();
  }

  /** The id read finds the row; the live-key read finds nothing (it left the index). */
  findOneBy(where: { id?: string }): Promise<PaymentIntentEntity | null> {
    return Promise.resolve(where.id ? (this.rows.get(where.id) ?? null) : null);
  }
}

function service(repository: RacingRepository): PaymentIntentService {
  return new PaymentIntentService(
    repository as unknown as PaymentIntentRepository,
    {} as LedgerService,
    {} as EscrowSpendGateService,
    noBlocks(),
  );
}

const INPUT: CreatePaymentIntentInput = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  agentAccount: AGENT,
  toolId: 'tool-1',
  rail: PaymentRail.RAIL_A_PER_CALL,
  callId: 'call-1',
  callClass: PaymentIntentCallClass.PAID,
  price: MoneyUtil.of('50000', USDC, 6),
  platformFee: MoneyUtil.of('5000', USDC, 6),
  requestHash: 'sha256:aa',
  chainId: CHAIN_IDS.SOLANA_DEVNET,
  idempotencyKey: 'key-1',
};

describe('PaymentIntentService.create — the idempotency race', () => {
  it('retries the insert once when the winning row left the index before it was read', async () => {
    const repository = new RacingRepository([
      uniqueViolation('idx_payment_intents_idempotency_key'),
    ]);

    const created = await service(repository).create(INPUT);

    expect(repository.inserts).toBe(2);
    expect(created.idempotencyKey).toBe('key-1');
    expect(repository.rows.size).toBe(1);
  });

  it('reports a collision when the second insert is refused too', async () => {
    const repository = new RacingRepository([
      uniqueViolation('idx_payment_intents_idempotency_key'),
      uniqueViolation('idx_payment_intents_idempotency_key'),
    ]);

    await expectErrorCodeAsync(
      () => service(repository).create(INPUT),
      PaymentErrorCode.PAYMENT_IDEMPOTENCY_KEY_REUSED,
    );
    expect(repository.inserts).toBe(2);
  });

  it('does not answer another unique index as a retry', async () => {
    const repository = new RacingRepository([uniqueViolation('idx_payment_intents_call_id')]);

    await expect(service(repository).create(INPUT)).rejects.toMatchObject({
      constraint: 'idx_payment_intents_call_id',
    });
    expect(repository.inserts).toBe(1);
  });
});
