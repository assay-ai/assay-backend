import { randomUUID } from 'node:crypto';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { LEGACY_POOLED_VAULT_TX_REF } from '@modules/ledger/ports/ledger.types';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import {
  PaymentIntentCallClass,
  PaymentIntentStatus,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * The `COMMIT` branch of `PaymentIntentService.resolve()` — the one guard that
 * decides whether a settled call has a payee.
 *
 * ## Why this file exists
 *
 * `PAYMENT_PROVIDER_NOT_ASSIGNED` had **zero** coverage anywhere in the suite
 * before this. That absence is not incidental: the guard carried a comment
 * saying a database CHECK made the state unreachable, the CHECK did not exist,
 * and the state was in fact reached by every single rail-A MCP call. Nothing
 * ever executed the line, so nothing ever contradicted the comment.
 *
 * ## What it proves, and what it does not
 *
 * It proves the **guard**: that a `VERIFYING → SETTLED` transition on an intent
 * with no `provider_account` refuses rather than crediting somebody, that it
 * refuses with that code, and — the part that matters for the money — that the
 * ledger is never asked to credit anyone on that path.
 *
 * It does **not** prove that the database refuses to store such a row. It
 * cannot: the repository here is a `Map`, and a CHECK constraint is a property
 * of Postgres. That claim is
 * `test/integration/payment/payment-intent-lifecycle.integration.spec.ts`'s.
 */

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const AGENT: AccountId =
  `${CHAIN_IDS.SOLANA_DEVNET}:9B2yKCsMTQNbMjJU3wvwhKxjvtpA6TmmbeLtPV4Totpo` as AccountId;
const PROVIDER_PAYOUT: AccountId =
  `${CHAIN_IDS.SOLANA_DEVNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId;
/** A rail-B hold is retired by this and by nothing else. */
const SIGNATURE = '4pXKq2Zr7wNvB1cYtH8mJ3dLsA6uQe9fRgT5kXnM2bVzC7yW1hD4jP8sE3aU6iO9rF';

/**
 * `PaymentIntentRepository` over a `Map`, with a compare-and-swap that really
 * compares.
 *
 * Only the four methods `resolve()` reaches are implemented. A repository that
 * accepted any transition would make the assertions below vacuous — the point
 * of the test is that the guard fires *after* a legal edge has been taken, on
 * an intent the state machine was perfectly happy to move.
 */
class FakeIntentRepository {
  readonly rows = new Map<string, PaymentIntentEntity>();

  seed(row: Partial<PaymentIntentEntity>): PaymentIntentEntity {
    const id = (row.id as string) ?? randomUUID();
    const seeded = { ...row, id } as PaymentIntentEntity;
    this.rows.set(id, seeded);
    return seeded;
  }

  findOneBy(where: { organizationId: string; id: string }): Promise<PaymentIntentEntity | null> {
    const row = this.rows.get(where.id);
    return Promise.resolve(row && row.organizationId === where.organizationId ? row : null);
  }

  transitionIfInStatus(
    organizationId: string,
    intentId: string,
    from: PaymentIntentStatus,
    to: PaymentIntentStatus,
    patch: Partial<PaymentIntentEntity>,
  ): Promise<number> {
    const row = this.rows.get(intentId);
    if (!row || row.organizationId !== organizationId || row.status !== from) {
      return Promise.resolve(0);
    }
    this.rows.set(intentId, { ...row, ...patch, status: to } as PaymentIntentEntity);
    return Promise.resolve(1);
  }

  update(
    where: { organizationId: string; id: string },
    patch: Partial<PaymentIntentEntity>,
  ): Promise<void> {
    const row = this.rows.get(where.id);
    if (row) this.rows.set(where.id, { ...row, ...patch } as PaymentIntentEntity);
    return Promise.resolve();
  }

  insert(): Promise<void> {
    throw new Error('not reachable from resolve()');
  }
}

class RecordingLedger {
  readonly credited: Array<Record<string, unknown>> = [];
  readonly released: string[] = [];

  commitHoldAndCredit(
    _organizationId: string,
    holdId: string,
    input: Record<string, unknown>,
  ): Promise<{ applied: boolean }> {
    this.credited.push({ holdId, ...input });
    return Promise.resolve({ applied: true });
  }

  releaseHold(_organizationId: string, holdId: string): Promise<{ applied: boolean }> {
    this.released.push(holdId);
    return Promise.resolve({ applied: true });
  }
}

function harness() {
  const intents = new FakeIntentRepository();
  const ledger = new RecordingLedger();
  // `secureFunds` calls the gate before `createHold`. This suite is
  // about the commit guard, not the gate — `ESCROW_SPEND_GATE_ENABLED` ships
  // off, and a disabled stub is what that looks like: present, never consulted
  // for a decision.
  const escrowGate = { enabled: false, assertAffordable: async () => undefined };
  const service = new PaymentIntentService(
    intents as unknown as PaymentIntentRepository,
    ledger as unknown as LedgerService,
    escrowGate as unknown as EscrowSpendGateService,
  );

  const organizationId = randomUUID();
  const verifying = (overrides: Partial<PaymentIntentEntity> = {}) =>
    intents.seed({
      organizationId,
      status: PaymentIntentStatus.VERIFYING,
      statusReason: null,
      agentId: randomUUID(),
      agentAccount: AGENT,
      providerId: randomUUID(),
      providerAccount: PROVIDER_PAYOUT,
      toolId: randomUUID(),
      bindingId: randomUUID(),
      rail: PaymentRail.RAIL_A_PER_CALL,
      callId: randomUUID(),
      callClass: PaymentIntentCallClass.PAID,
      assetId: USDC,
      decimals: 6,
      priceAmount: '1000000',
      providerAmount: '800000',
      platformFee: '200000',
      settledAmount: null,
      requestHash: 'a'.repeat(64),
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      expiresAt: new Date(Date.now() + 300_000),
      idempotencyKey: null,
      voucherNonce: null,
      holdId: randomUUID(),
      holdReleasedAt: null,
      classification: null,
      verificationVerdict: null,
      ...overrides,
    } as Partial<PaymentIntentEntity>);

  return { service, intents, ledger, organizationId, verifying };
}

describe('PaymentIntentService.resolve() — the COMMIT branch needs a payee', () => {
  it('refuses to settle an intent whose provider_account is null', async () => {
    const { service, organizationId, verifying } = harness();
    const intent = verifying({ providerAccount: null });

    await expectErrorCodeAsync(
      () =>
        service.resolve(
          organizationId,
          intent.id,
          PaymentIntentStatus.VERIFYING,
          PaymentIntentStatus.SETTLED,
        ),
      PaymentErrorCode.PAYMENT_PROVIDER_NOT_ASSIGNED,
    );
  });

  it('credits nobody when it refuses — the hold stays open rather than moving wrongly', async () => {
    const { service, ledger, intents, organizationId, verifying } = harness();
    const intent = verifying({ providerAccount: null });

    await service
      .resolve(
        organizationId,
        intent.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
      )
      .catch(() => undefined);

    // The money is the assertion. Refusing loudly and then crediting anyway
    // would be the worst of both, and refusing by *releasing* would hand the
    // agent back a call the provider actually served.
    expect(ledger.credited).toEqual([]);
    expect(ledger.released).toEqual([]);
    expect(intents.rows.get(intent.id).holdReleasedAt).toBeNull();
  });

  it('leaves the status already moved — which is why the guard is not a substitute for the CHECK', async () => {
    const { service, intents, organizationId, verifying } = harness();
    const intent = verifying({ providerAccount: null });

    await service
      .resolve(
        organizationId,
        intent.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
      )
      .catch(() => undefined);

    // `resolve()` transitions first and applies the hold effect second, so by
    // the time the guard fires the row already says `SETTLED`. That is exactly
    // the state `chk_payment_intents_settled_names_payee` exists to make
    // impossible: the guard cannot prevent the row, only the credit.
    expect(intents.rows.get(intent.id).status).toBe(PaymentIntentStatus.SETTLED);
    expect(intents.rows.get(intent.id).holdReleasedAt).toBeNull();
  });

  it('refuses on a null provider_id too, with the same code', async () => {
    const { service, organizationId, verifying } = harness();
    const intent = verifying({ providerId: null });

    await expectErrorCodeAsync(
      () =>
        service.resolve(
          organizationId,
          intent.id,
          PaymentIntentStatus.VERIFYING,
          PaymentIntentStatus.SETTLED,
        ),
      PaymentErrorCode.PAYMENT_PROVIDER_NOT_ASSIGNED,
    );
  });

  it('settles and credits the named payout account when both halves are present', async () => {
    const { service, ledger, intents, organizationId, verifying } = harness();
    const intent = verifying();

    await service.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.VERIFYING,
      PaymentIntentStatus.SETTLED,
    );

    expect(ledger.credited).toHaveLength(1);
    // The provider is credited AT THE ACCOUNT ON THE ROW — not at a lookup, not
    // at the agent's account, and with the provider's share rather than the
    // price. This is the positive half of the missing-payee defect.
    expect(ledger.credited[0]).toMatchObject({
      holdId: intent.holdId,
      providerOrganizationId: intent.providerId,
      providerAccountId: PROVIDER_PAYOUT,
      providerAmount: expect.objectContaining({ amount: '800000' }),
      platformFee: expect.objectContaining({ amount: '200000' }),
    });
    expect(intents.rows.get(intent.id).holdReleasedAt).not.toBeNull();
  });

  it('names the legacy pooled vault on a rail-A commit, because no chain transaction moved', async () => {
    // `chainTxRef` is required. Rail A does not move anything on
    // chain — its money sits in the pooled Squads vault — so the honest ref is
    // a documented sentinel, greppable in the journal, rather than a NULL that
    // reads as "somebody forgot to record the signature".
    const { service, ledger, organizationId, verifying } = harness();
    const intent = verifying();

    await service.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.VERIFYING,
      PaymentIntentStatus.SETTLED,
    );

    expect(ledger.credited[0]).toMatchObject({ chainTxRef: LEGACY_POOLED_VAULT_TX_REF });
  });

  it('releases without a payee on the REFUND edge, because a release pays nobody', async () => {
    const { service, ledger, organizationId, verifying } = harness();
    const intent = verifying({ providerAccount: null });

    await service.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.VERIFYING,
      PaymentIntentStatus.REFUNDED,
    );

    // The reason `REFUNDED` is deliberately absent from
    // `chk_payment_intents_settled_names_payee`'s status list: this edge's
    // `holdEffect` is `RELEASE`, and it must not be blocked by a value it does
    // not read.
    expect(ledger.released).toEqual([intent.holdId]);
    expect(ledger.credited).toEqual([]);
  });
});

describe('PaymentIntentService — a rail-B hold is retired by the redemption', () => {
  it('leaves a rail-B hold open when the intent settles, because the money has not moved yet', async () => {
    const { service, ledger, intents, organizationId, verifying } = harness();
    const intent = verifying({ rail: PaymentRail.RAIL_B_VOUCHER });

    const settled = await service.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.VERIFYING,
      PaymentIntentStatus.SETTLED,
    );

    expect(settled.status).toBe(PaymentIntentStatus.SETTLED);
    expect(settled.holdReleasedAt).toBeNull();
    expect(ledger.credited).toEqual([]);
    expect(intents.rows.get(intent.id).holdReleasedAt).toBeNull();
  });

  it('still commits a rail-A hold inline — there is no voucher to redeem', async () => {
    const { service, ledger, organizationId, verifying } = harness();
    const intent = verifying({ rail: PaymentRail.RAIL_A_PER_CALL });

    await service.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.VERIFYING,
      PaymentIntentStatus.SETTLED,
    );

    expect(ledger.credited).toHaveLength(1);
  });

  it('releases a rail-B hold inline on REFUND — nothing moved, so nothing waits', async () => {
    const { service, ledger, organizationId, verifying } = harness();
    const intent = verifying({ rail: PaymentRail.RAIL_B_VOUCHER });

    await service.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.VERIFYING,
      PaymentIntentStatus.REFUNDED,
    );

    expect(ledger.released).toEqual([intent.holdId]);
    expect(ledger.credited).toEqual([]);
  });

  it('commitRedeemedHold is the only path that retires a rail-B hold, and it names the signature', async () => {
    const { service, ledger, intents, organizationId, verifying } = harness();
    const intent = verifying({
      rail: PaymentRail.RAIL_B_VOUCHER,
      status: PaymentIntentStatus.SETTLED,
    });

    await service.commitRedeemedHold(organizationId, intent.id, SIGNATURE);

    expect(ledger.credited).toHaveLength(1);
    expect(ledger.credited[0]).toMatchObject({
      holdId: intent.holdId,
      chainTxRef: SIGNATURE,
      providerAccountId: PROVIDER_PAYOUT,
    });
    expect(intents.rows.get(intent.id).holdReleasedAt).not.toBeNull();
  });

  it('refuses to commit a redeemed hold on an intent that never settled', async () => {
    const { service, ledger, organizationId, verifying } = harness();
    const intent = verifying({
      rail: PaymentRail.RAIL_B_VOUCHER,
      status: PaymentIntentStatus.VERIFYING,
    });

    await expectErrorCodeAsync(
      () => service.commitRedeemedHold(organizationId, intent.id, SIGNATURE),
      PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    );
    expect(ledger.credited).toEqual([]);
  });

  it('is a no-op on a hold already retired, so a retried redemption pass pays nobody twice', async () => {
    const { service, ledger, organizationId, verifying } = harness();
    const intent = verifying({
      rail: PaymentRail.RAIL_B_VOUCHER,
      status: PaymentIntentStatus.SETTLED,
      holdReleasedAt: new Date(),
    });

    await service.commitRedeemedHold(organizationId, intent.id, SIGNATURE);

    expect(ledger.credited).toEqual([]);
  });

  it('refuses a rail-A intent outright — its hold was already retired inline', async () => {
    const { service, ledger, organizationId, verifying } = harness();
    const intent = verifying({
      rail: PaymentRail.RAIL_A_PER_CALL,
      status: PaymentIntentStatus.SETTLED,
    });

    await expectErrorCodeAsync(
      () => service.commitRedeemedHold(organizationId, intent.id, SIGNATURE),
      PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION,
    );
    expect(ledger.credited).toEqual([]);
  });
});
