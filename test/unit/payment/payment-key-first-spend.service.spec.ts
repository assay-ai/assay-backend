import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { NOTIFICATION_CATALOGUE } from '@modules/notification/constants/notification-catalogue';
import {
  NotificationAggregation,
  NotificationEvent,
  NotificationPort,
  NotificationRequest,
} from '@modules/notification/ports/notification.port';
import {
  PaymentIntent,
  PaymentIntentCallClass,
  PaymentIntentStatus,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import {
  PaymentKeyFirstSpendService,
  paymentKeyFirstSpendDedupeKey,
} from '@modules/payment/services/payment-key-first-spend.service';
import { MoneyUtil } from '@shared/utils/money.util';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET as ChainId;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET as AssetId;
const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const DELEGATE = `${CHAIN}:${ADDRESS}`;
const ORG = '00000000-0000-4000-8000-000000000001';

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    organizationId: ORG,
    status: PaymentIntentStatus.FUNDS_SECURED,
    agentId: '00000000-0000-4000-8000-0000000000b1',
    agentAccount: `${CHAIN}:0x1111111111111111111111111111111111111111`,
    providerId: '00000000-0000-4000-8000-0000000000c1',
    toolId: '00000000-0000-4000-8000-0000000000d1',
    rail: PaymentRail.RAIL_B_VOUCHER,
    callClass: PaymentIntentCallClass.PAID,
    price: MoneyUtil.of(10_000n, USDG, 6),
    platformFee: MoneyUtil.of(1_000n, USDG, 6),
    chainId: CHAIN,
    voucherSeq: '7',
    voucherDelegate: DELEGATE,
    credentialId: '00000000-0000-4000-8000-0000000000e1',
    createdAt: new Date('2026-10-19T10:00:00.000Z'),
    ...overrides,
  } as unknown as PaymentIntent;
}

function harness(opts: { earlier?: boolean | Error } = {}) {
  const sent: NotificationRequest[] = [];
  const notifications: NotificationPort = {
    notify: jest.fn(async (request: NotificationRequest) => {
      sent.push(request);
      return { deliveredNow: true };
    }),
  };
  const intents = {
    hasEarlierDelegateSpend: jest.fn(async () => {
      if (opts.earlier instanceof Error) throw opts.earlier;
      return opts.earlier ?? false;
    }),
  };
  const service = new PaymentKeyFirstSpendService(
    intents as unknown as PaymentIntentRepository,
    notifications,
    { findOne: jest.fn(async () => ({ name: 'Laptop' })) } as unknown as AgentCredentialRepository,
    { findOne: jest.fn(async () => ({ label: 'research-bot' })) } as unknown as AgentRepository,
    { findOne: jest.fn(async () => ({ name: 'get_weather' })) } as unknown as ToolRepository,
  );
  return { service, sent, intents };
}

describe('PaymentKeyFirstSpendService (payment_key.first_spend)', () => {
  it('is in the catalogue as ONCE, email included, and not mutable', () => {
    const row = NOTIFICATION_CATALOGUE[NotificationEvent.PAYMENT_KEY_FIRST_SPEND];
    expect(NotificationEvent.PAYMENT_KEY_FIRST_SPEND).toBe('payment_key.first_spend');
    expect(row.aggregation).toBe(NotificationAggregation.ONCE);
    expect(row.channels).toContain('EMAIL');
    expect(row.nonSuppressible).toBe(true);
  });

  it('first delegate-signed redemption → one notification; second → none', async () => {
    const first = harness({ earlier: false });
    await expect(first.service.notifyIfFirst(intent())).resolves.toBe(true);
    expect(first.sent).toHaveLength(1);
    const [request] = first.sent;
    expect(request).toMatchObject({
      organizationId: ORG,
      event: NotificationEvent.PAYMENT_KEY_FIRST_SPEND,
      subjectType: 'credential',
      subjectId: '00000000-0000-4000-8000-0000000000e1',
      dedupeKey: `payment-key-first-spend:${CHAIN}:${ADDRESS.toLowerCase()}`,
    });
    expect(first.intents.hasEarlierDelegateSpend).toHaveBeenCalledWith(ORG, DELEGATE, {
      id: '00000000-0000-4000-8000-0000000000a1',
      createdAt: new Date('2026-10-19T10:00:00.000Z'),
    });

    // The next voucher of the same key: the table already holds a spend.
    const second = harness({ earlier: true });
    await expect(second.service.notifyIfFirst(intent({ id: 'later' }))).resolves.toBe(false);
    expect(second.sent).toHaveLength(0);
  });

  it('names the key by its last eight characters and the amount exactly, never the full address', async () => {
    const { service, sent } = harness();
    await service.notifyIfFirst(intent());
    const [request] = sent;
    expect(request.body).toContain('ending EF1BEAED');
    expect(request.body).toContain('0.010000 USDG');
    expect(request.body).toContain('"Laptop"');
    expect(request.body).toContain('"research-bot"');
    expect(request.body).toContain('"get_weather"');
    // What is stored and shown: title, body, payload. (The dedupe key names the
    // key in full, as the brief fixes it, but only as a Redis suppression key.)
    const text = JSON.stringify([request.title, request.body, request.payload]).toLowerCase();
    expect(text).not.toContain(ADDRESS.toLowerCase().slice(2));
    expect(request.payload).toMatchObject({
      keyEnding: 'EF1BEAED',
      amount: '10000',
      asset: USDG,
      decimals: 6,
      chainId: CHAIN,
    });
  });

  it('payer-signed voucher → none, and the table is not asked', async () => {
    const { service, sent, intents } = harness();
    await expect(service.notifyIfFirst(intent({ voucherDelegate: null }))).resolves.toBe(false);
    expect(sent).toHaveLength(0);
    expect(intents.hasEarlierDelegateSpend).not.toHaveBeenCalled();
  });

  it('a rail-A intent → none', async () => {
    const { service, sent } = harness();
    await service.notifyIfFirst(intent({ rail: PaymentRail.RAIL_A_PER_CALL }));
    expect(sent).toHaveLength(0);
  });

  it('two concurrent first vouchers ask with the same ONCE key, so the service keeps one', async () => {
    const { service, sent } = harness({ earlier: false });
    await Promise.all([
      service.notifyIfFirst(intent({ id: 'a' })),
      service.notifyIfFirst(intent({ id: 'b' })),
    ]);
    expect(new Set(sent.map((request) => request.dedupeKey)).size).toBe(1);
  });

  it('the dedupe key does not depend on the address case', () => {
    expect(paymentKeyFirstSpendDedupeKey(CHAIN, DELEGATE)).toBe(
      paymentKeyFirstSpendDedupeKey(CHAIN, `${CHAIN}:${ADDRESS.toLowerCase()}`),
    );
  });

  it('afterAdmitted neither waits nor throws when the check fails', async () => {
    const { service, sent } = harness({ earlier: new Error('db down') });
    expect(() => service.afterAdmitted(intent())).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(0);
  });
});
