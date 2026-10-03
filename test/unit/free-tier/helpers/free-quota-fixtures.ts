import type { Redis } from 'ioredis';

import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ToolCallRecordRepository } from '@database/postgres/repositories/tool-call-record.repository';
import { FreeQuotaConfig } from '@modules/free-tier/config/free-quota.config';
import { FreeQuotaService } from '@modules/free-tier/services/free-quota.service';
import {
  NotificationPort,
  NotificationRequest,
} from '@modules/notification/ports/notification.port';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';

import { FakeRedis } from '../../tool/helpers/fake-redis';

export const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
export const AGENT_ID = '22222222-2222-4222-8222-222222222222';
export const TOOL_ID = 'search_web_preview';
export const STAKE_ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;

/** One `tool_bindings` row, reduced to the fields `toToolBinding` reads. */
export function buildBindingRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    organizationId: `provider-${id}`,
    toolId: TOOL_ID,
    endpoint: `https://${id}.example.com/api`,
    requestMapping: { method: 'POST', path: '/search', body: {} },
    responseMapping: {},
    pricingMode: PricingMode.FREE,
    priceAmount: '0',
    assetId: STAKE_ASSET,
    freeQuotaPerAgent: null,
    freeDailyBudget: null,
    maxRps: null,
    maxDailyCalls: null,
    slaFailureRate: '0.02',
    timeoutMs: 5_000,
    status: BindingStatus.ACTIVE,
    mappingVersion: 1,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** `ToolCallRecordRepository`, over an array — the four grains `FreeQuotaService` reads. */
export class FakeToolCallRecordRepository {
  readonly rows: Array<{
    readonly organizationId: string;
    readonly agentId: string;
    readonly toolId: string;
    readonly bindingId: string | null;
    readonly createdAt: Date;
  }> = [];

  readonly queries: string[] = [];
  down = false;

  countForAgentBindingSince(
    organizationId: string,
    agentId: string,
    bindingId: string,
    since: Date,
  ): Promise<number> {
    this.queries.push(`agentBinding:${agentId}:${bindingId}`);
    if (this.down) return Promise.reject(new Error('postgres is unreachable'));
    return Promise.resolve(
      this.rows.filter(
        (row) =>
          row.organizationId === organizationId &&
          row.agentId === agentId &&
          row.bindingId === bindingId &&
          row.createdAt >= since,
      ).length,
    );
  }

  countForAgentSince(organizationId: string, agentId: string, since: Date): Promise<number> {
    this.queries.push(`agent:${agentId}`);
    if (this.down) return Promise.reject(new Error('postgres is unreachable'));
    return Promise.resolve(
      this.rows.filter(
        (row) =>
          row.organizationId === organizationId &&
          row.agentId === agentId &&
          row.createdAt >= since,
      ).length,
    );
  }

  countForBindingSince(bindingId: string, since: Date): Promise<number> {
    this.queries.push(`binding:${bindingId}`);
    if (this.down) return Promise.reject(new Error('postgres is unreachable'));
    return Promise.resolve(
      this.rows.filter((row) => row.bindingId === bindingId && row.createdAt >= since).length,
    );
  }

  distinctToolIdsForAgentSince(
    organizationId: string,
    agentId: string,
    since: Date,
  ): Promise<string[]> {
    if (this.down) return Promise.reject(new Error('postgres is unreachable'));
    const ids = new Set(
      this.rows
        .filter(
          (row) =>
            row.organizationId === organizationId &&
            row.agentId === agentId &&
            row.createdAt >= since,
        )
        .map((row) => row.toolId),
    );
    return Promise.resolve([...ids]);
  }

  /** What the writer would have appended, for a test to seed Postgres directly. */
  append(bindingId: string | null, createdAt: Date = new Date()): void {
    this.rows.push({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      toolId: TOOL_ID,
      bindingId,
      createdAt,
    });
  }
}

/** `ToolBindingRepository.findByTool`, over an array. */
export class FakeToolBindingRepository {
  constructor(private rows: Array<ReturnType<typeof buildBindingRow>> = []) {}

  findByTool(toolId: string): Promise<Array<ReturnType<typeof buildBindingRow>>> {
    return Promise.resolve(this.rows.filter((row) => row.toolId === toolId));
  }

  setRows(rows: Array<ReturnType<typeof buildBindingRow>>): void {
    this.rows = rows;
  }
}

/** `NotificationPort`, recording every call rather than sending anything. */
export class FakeNotificationPort implements NotificationPort {
  readonly notified: NotificationRequest[] = [];

  notify(request: NotificationRequest): Promise<{ deliveredNow: boolean }> {
    this.notified.push(request);
    // `IN_APP` is delivered synchronously by the real service, so a fake that
    // reported otherwise would let a delivery-clock bug through.
    return Promise.resolve({ deliveredNow: true });
  }
}

export const DEFAULT_TEST_CONFIG: FreeQuotaConfig = {
  platformAgentDailyLimit: 1_000,
  platformRateLimitPerMinute: 60,
  defaultPerAgentDailyLimit: 100,
  defaultProviderDailyBudget: 50_000,
  retentionDays: 30,
  retentionSweepBatchSize: 500,
};

export interface FreeQuotaHarness {
  readonly redis: FakeRedis;
  readonly records: FakeToolCallRecordRepository;
  readonly bindings: FakeToolBindingRepository;
  readonly notifications: FakeNotificationPort;
  readonly service: FreeQuotaService;
}

export function buildFreeQuotaHarness(
  overrides: Partial<FreeQuotaConfig> = {},
  bindingRows: Array<ReturnType<typeof buildBindingRow>> = [buildBindingRow('b1')],
): FreeQuotaHarness {
  const redis = new FakeRedis();
  const records = new FakeToolCallRecordRepository();
  const bindings = new FakeToolBindingRepository(bindingRows);
  const notifications = new FakeNotificationPort();
  const config: FreeQuotaConfig = { ...DEFAULT_TEST_CONFIG, ...overrides };

  const service = new FreeQuotaService(
    redis as unknown as Redis,
    records as unknown as ToolCallRecordRepository,
    bindings as unknown as ToolBindingRepository,
    config,
    notifications,
  );

  return { redis, records, bindings, notifications, service };
}
