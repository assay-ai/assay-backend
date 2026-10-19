import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import {
  DelegateSpendRow,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import {
  PAYMENT_KEY_DAILY_SUMMARY_CRON,
  PAYMENT_KEY_DAILY_SUMMARY_LOCK_KEY,
} from '@modules/account/constants/payment-key-daily-summary.constants';
import { PaymentKeyDailySummaryJob } from '@modules/account/jobs/payment-key-daily-summary.job';
import { PaymentKeyDailySummaryService } from '@modules/account/services/payment-key-daily-summary.service';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { NOTIFICATION_CATALOGUE } from '@modules/notification/constants/notification-catalogue';
import {
  NotificationAggregation,
  NotificationEvent,
  NotificationPort,
  NotificationRequest,
} from '@modules/notification/ports/notification.port';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET as string;
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const KEY_1 = `${CHAIN}:0x1111111111111111111111111111111111a1b2c3`;
const KEY_2 = `${CHAIN}:0x22222222222222222222222222222222dEadBeef`;
const NOW = new Date('2026-10-19T00:20:00.000Z').getTime();

function row(overrides: Partial<DelegateSpendRow>): DelegateSpendRow {
  return {
    organizationId: ORG_A,
    credentialId: 'cred-1',
    agentId: 'agent-1',
    delegate: KEY_1,
    chainId: CHAIN,
    assetId: USDG,
    decimals: 6,
    calls: 1,
    amount: 10_000n,
    ...overrides,
  };
}

function harness(rows: DelegateSpendRow[], lock: 'OK' | null | Error = 'OK') {
  const sent: NotificationRequest[] = [];
  const notifications: NotificationPort = {
    notify: jest.fn(async (request: NotificationRequest) => {
      sent.push(request);
      return { deliveredNow: true };
    }),
  };
  const intents = { sumDelegateSpendByKey: jest.fn(async () => rows) };
  const names: Record<string, string> = { 'cred-1': 'Laptop', 'cred-2': 'Build box' };
  const credentials = {
    findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
      names[where.id] ? { name: names[where.id] } : null,
    ),
  };
  const agents = { findOne: jest.fn(async () => ({ label: 'research-bot' })) };
  const redis = {
    set: jest.fn(async () => {
      if (lock instanceof Error) throw lock;
      return lock;
    }),
  };
  const service = new PaymentKeyDailySummaryService(
    intents as unknown as PaymentIntentRepository,
    notifications,
    { now: () => NOW },
    credentials as unknown as AgentCredentialRepository,
    agents as unknown as AgentRepository,
    redis as never,
  );
  return { service, sent, intents, redis };
}

describe('PaymentKeyDailySummaryService (payment_key.daily_summary)', () => {
  it('is in the catalogue as ONCE_PER_UTC_DAY, email included', () => {
    const definition = NOTIFICATION_CATALOGUE[NotificationEvent.PAYMENT_KEY_DAILY_SUMMARY];
    expect(NotificationEvent.PAYMENT_KEY_DAILY_SUMMARY).toBe('payment_key.daily_summary');
    expect(definition.aggregation).toBe(NotificationAggregation.ONCE_PER_UTC_DAY);
    expect(definition.channels).toContain('EMAIL');
  });

  it('summarises the previous UTC day, [00:00, 24:00)', async () => {
    const { service, intents } = harness([]);
    await expect(service.run()).resolves.toEqual({
      skipped: false,
      day: '2026-10-18',
      organizations: 0,
      keys: 0,
    });
    expect(intents.sumDelegateSpendByKey).toHaveBeenCalledWith(
      new Date('2026-10-18T00:00:00.000Z'),
      new Date('2026-10-19T00:00:00.000Z'),
    );
  });

  it('summary lists amount and count per key; no key with zero spend', async () => {
    const { service, sent } = harness([
      row({ calls: 12, amount: 120_000n }),
      row({ credentialId: 'cred-2', delegate: KEY_2, calls: 1, amount: 2_500_001n }),
      // Another organization: its own notice, never in this one.
      row({ organizationId: ORG_B, credentialId: 'cred-9', calls: 3, amount: 30_000n }),
    ]);

    const result = await service.run();

    expect(result).toEqual({ skipped: false, day: '2026-10-18', organizations: 2, keys: 3 });
    expect(sent).toHaveLength(2);
    const [a, b] = sent;
    expect(a).toMatchObject({
      organizationId: ORG_A,
      event: NotificationEvent.PAYMENT_KEY_DAILY_SUMMARY,
      dedupeKey: 'payment-key-daily-summary:2026-10-18',
    });
    expect(a.title).toBe('Payment key spend on Oct 18 (UTC)');
    expect(a.body).toContain(
      'Key "Laptop" of "research-bot" (payment key ending 11A1B2C3): 12 paid calls, 0.120000 USDG',
    );
    expect(a.body).toContain(
      'Key "Build box" of "research-bot" (payment key ending DEADBEEF): 1 paid call, 2.500001 USDG',
    );
    expect(a.payload).toMatchObject({
      day: '2026-10-18',
      keys: [
        {
          credentialId: 'cred-1',
          keyEnding: '11A1B2C3',
          calls: 12,
          spend: [{ asset: USDG, decimals: 6, amount: '120000' }],
        },
        {
          credentialId: 'cred-2',
          keyEnding: 'DEADBEEF',
          calls: 1,
          spend: [{ asset: USDG, decimals: 6, amount: '2500001' }],
        },
      ],
    });
    // No full key address anywhere a person or a webhook sees.
    const text = JSON.stringify([a.title, a.body, a.payload]).toLowerCase();
    expect(text).not.toContain('0x1111111111111111111111111111111111a1b2c3');
    expect(text).not.toContain('0x22222222222222222222222222222222deadbeef');
    expect(b.organizationId).toBe(ORG_B);
    expect(b.body).not.toContain('Laptop');
  });

  it('adds up one key’s rows for an asset exactly, beyond 2^53', async () => {
    const big = 2n ** 60n;
    const { service, sent } = harness([
      row({ calls: 1, amount: big }),
      row({ calls: 2, amount: big + 1n }),
    ]);
    await service.run();
    expect(sent[0].payload).toMatchObject({
      keys: [{ calls: 3, spend: [{ amount: (2n * big + 1n).toString() }] }],
    });
  });

  it('an organization with no spend gets nothing', async () => {
    const { service, sent } = harness([]);
    await service.run();
    expect(sent).toHaveLength(0);
  });

  it('a second replica, or a retry inside the hour, does nothing (the lock)', async () => {
    const { service, sent, intents, redis } = harness([row({})], null);
    await expect(service.run()).resolves.toEqual({ skipped: true });
    expect(redis.set).toHaveBeenCalledWith(
      PAYMENT_KEY_DAILY_SUMMARY_LOCK_KEY,
      '1',
      'EX',
      3600,
      'NX',
    );
    expect(intents.sumDelegateSpendByKey).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('without Redis it skips rather than risk sending twice', async () => {
    const { service, sent } = harness([row({})], new Error('redis down'));
    await expect(service.run()).resolves.toEqual({ skipped: true });
    expect(sent).toHaveLength(0);
  });

  it('a run that gets past the lock asks with the same per-day key, so ONCE_PER_UTC_DAY keeps one', async () => {
    const first = harness([row({})]);
    const second = harness([row({})]);
    await first.service.run();
    await second.service.run();
    expect(first.sent[0].dedupeKey).toBe(second.sent[0].dedupeKey);
  });

  it('runs daily at 00:20 UTC, one pass at a time', () => {
    expect(PAYMENT_KEY_DAILY_SUMMARY_CRON).toBe('0 20 0 * * *');
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      PaymentKeyDailySummaryJob.prototype.handlePaymentKeyDailySummary,
    ) as { cronTime?: string; timeZone?: string; waitForCompletion?: boolean };
    expect(options).toMatchObject({
      cronTime: PAYMENT_KEY_DAILY_SUMMARY_CRON,
      timeZone: 'UTC',
      waitForCompletion: true,
    });
  });

  it('the scheduler side imports nothing from OAuth (no OAUTH_CONFIG, no OAuthMetrics)', () => {
    const root = join(__dirname, '../../../src/modules/account');
    const sources = [
      'account-scheduler.module.ts',
      'jobs/payment-key-daily-summary.job.ts',
      'services/payment-key-daily-summary.service.ts',
      'constants/payment-key-daily-summary.constants.ts',
    ].map((file) => readFileSync(join(root, file), 'utf8'));
    for (const source of sources) {
      expect(source).not.toMatch(/from '@modules\/oauth/);
      expect(source).not.toMatch(/\b(?:OAUTH_CONFIG|OAuthMetrics|loadOAuthConfig)\b/);
    }
  });
});
