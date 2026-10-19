import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { NotificationChannelRepository } from '@database/postgres/repositories/notification-channel.repository';
import { NotificationDeliveryRepository } from '@database/postgres/repositories/notification-delivery.repository';
import { NotificationPreferenceRepository } from '@database/postgres/repositories/notification-preference.repository';
import { NotificationRepository } from '@database/postgres/repositories/notification.repository';
import { NotificationDeliverPublisher } from '@modules/notification/publishers/notification-deliver.publisher';
import { NotificationService } from '@modules/notification/services/notification.service';
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

import { FakeRedis } from '../notification/helpers/fake-redis';

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
      dedupeKey: paymentKeyFirstSpendDedupeKey(CHAIN, DELEGATE),
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
    const text = JSON.stringify(request).toLowerCase();
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

  it('once a key is known to have spent, later vouchers skip the table (the Redis marker)', async () => {
    const store = new Map<string, string>();
    const redis = {
      exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
    };
    const sent: NotificationRequest[] = [];
    const table = { hasEarlierDelegateSpend: jest.fn(async () => false) };
    const service = new PaymentKeyFirstSpendService(
      table as unknown as PaymentIntentRepository,
      {
        notify: async (request: NotificationRequest) => (
          sent.push(request),
          { deliveredNow: true }
        ),
      },
      { findOne: jest.fn(async () => null) } as unknown as AgentCredentialRepository,
      { findOne: jest.fn(async () => null) } as unknown as AgentRepository,
      { findOne: jest.fn(async () => null) } as unknown as ToolRepository,
      redis as unknown as Redis,
    );

    await expect(service.notifyIfFirst(intent({ id: 'a' }))).resolves.toBe(true);
    await expect(service.notifyIfFirst(intent({ id: 'b' }))).resolves.toBe(false);
    expect(table.hasEarlierDelegateSpend).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect([...store.keys()].join()).not.toContain(ADDRESS.toLowerCase().slice(2));

    // An unreadable marker is a miss: the table decides.
    redis.exists.mockRejectedValueOnce(new Error('redis down'));
    table.hasEarlierDelegateSpend.mockResolvedValueOnce(true);
    await expect(service.notifyIfFirst(intent({ id: 'c' }))).resolves.toBe(false);
    expect(sent).toHaveLength(1);
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

  /**
   * Through the real `NotificationService` (Redis faked): two concurrent first
   * vouchers make one inbox row, and the full key address reaches no log line
   * and no Redis key, on the sent path or the suppressed one.
   */
  it('through the real notification service: one row, and no full address in any log or Redis key', async () => {
    const lines: string[] = [];
    const methods = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;
    const spies = methods.map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(' '));
      }),
    );
    try {
      const redis = new FakeRedis();
      const inserted: unknown[] = [];
      const notifications = new NotificationService(
        {
          insert: jest.fn(async (row: unknown) => inserted.push(row)),
        } as unknown as NotificationRepository,
        {
          findForOrganization: jest.fn(async () => []),
        } as unknown as NotificationChannelRepository,
        { findForEvent: jest.fn(async () => []) } as unknown as NotificationPreferenceRepository,
        { insert: jest.fn(async () => undefined) } as unknown as NotificationDeliveryRepository,
        {
          publishDeliver: jest.fn(async () => undefined),
        } as unknown as NotificationDeliverPublisher,
        redis as unknown as Redis,
      );
      const service = new PaymentKeyFirstSpendService(
        {
          hasEarlierDelegateSpend: jest.fn(async () => false),
        } as unknown as PaymentIntentRepository,
        notifications,
        { findOne: jest.fn(async () => null) } as unknown as AgentCredentialRepository,
        { findOne: jest.fn(async () => null) } as unknown as AgentRepository,
        { findOne: jest.fn(async () => null) } as unknown as ToolRepository,
      );

      await Promise.all([
        service.notifyIfFirst(intent({ id: 'a' })),
        service.notifyIfFirst(intent({ id: 'b' })),
      ]);

      expect(inserted).toHaveLength(1);
      expect(lines.some((line) => line.includes('suppressed'))).toBe(true);
      const seen = [...lines, ...redis.commands, JSON.stringify(inserted)].join('\n').toLowerCase();
      expect(seen).not.toContain(ADDRESS.toLowerCase().slice(2));
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
