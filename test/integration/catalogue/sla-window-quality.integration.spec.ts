import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { SlaWindowRepository } from '@database/postgres/repositories/sla-window.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

const DAY_MS = 24 * 60 * 60 * 1000;
const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;

/**
 * `SlaWindowRepository.qualityByProvider` against real Postgres: the public
 * failure rate sums OPEN windows and the CLOSED windows of the last 30 days
 * (owner decision D5), so a provider's current traffic is in the figure and a
 * few old closed windows cannot stand for it.
 */
describe('SlaWindowRepository.qualityByProvider — open plus closed, last 30 days', () => {
  let dataSource: DataSource;
  let windows: SlaWindowRepository;
  const now = new Date('2026-10-18T12:00:00.000Z');

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase('goassay_sla_quality_test');
    windows = new SlaWindowRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  /** A provider with one binding; returns the ids its windows hang off. */
  async function providerWithBinding(): Promise<{
    providerId: string;
    bindingId: string;
    toolId: string;
  }> {
    const providerId = randomUUID();
    const bindingId = randomUUID();
    const toolId = randomUUID();
    await dataSource.query(
      `INSERT INTO tools (id, name, kind, category, visibility, status)
       VALUES ($1, $2, 'STANDARD', 'testing', 'LISTED', 'ACTIVE')`,
      [toolId, `quality_tool_${toolId.replace(/-/g, '').slice(0, 24)}`],
    );
    await dataSource.query(
      `INSERT INTO tool_bindings
         (id, organization_id, tool_id, endpoint, request_mapping, response_mapping, pricing_mode,
          price_amount, asset_id, sla_failure_rate, timeout_ms, settlement_chains, status)
       VALUES ($1, $2, $3, 'https://example.invalid', '{}'::jsonb, '{}'::jsonb, 'PAID',
               100000, $4, 0.05, 1000, ARRAY[$5]::varchar[], 'DRAFT')`,
      [bindingId, providerId, toolId, ASSET, ASSET.split('/')[0]],
    );
    return { providerId, bindingId, toolId };
  }

  let sequence = 0;
  async function window(
    owner: { providerId: string; bindingId: string; toolId: string },
    input: { status: 'OPEN' | 'CLOSED'; verified: number; failed: number; closedDaysAgo?: number },
  ): Promise<void> {
    sequence += 1;
    const closedAt =
      input.status === 'CLOSED'
        ? new Date(now.getTime() - (input.closedDaysAgo ?? 1) * DAY_MS)
        : null;
    const openedAt = new Date((closedAt ?? now).getTime() - DAY_MS);
    await dataSource.query(
      `INSERT INTO sla_windows
         (id, organization_id, provider_id, binding_id, tool_id, sequence, status, opened_at,
          deadline_at, declared_failure_rate, min_verified_calls, z_score, max_age_ms, warning_ratio,
          warning_min_sample_fraction, penalty_multiplier, asset_id, total_calls, verified_calls,
          failed_calls, closed_at, outcome)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, 0.05, 400, 1.645, 604800000, 0.8, 0.5, 1,
               $9, $10, $10, $11, $12, $13)`,
      [
        randomUUID(),
        owner.providerId,
        owner.bindingId,
        owner.toolId,
        sequence,
        input.status,
        openedAt,
        new Date(openedAt.getTime() + 7 * DAY_MS),
        ASSET,
        input.verified,
        input.failed,
        closedAt,
        input.status === 'CLOSED' ? 'INSUFFICIENT_SAMPLE' : null,
      ],
    );
  }

  it('counts open windows beside closed ones (the seeded "100% failed" case)', async () => {
    const owner = await providerWithBinding();
    // Eight closed one-call windows, all failed — what the old figure showed alone.
    for (let i = 0; i < 8; i += 1) {
      await window(owner, { status: 'CLOSED', verified: 1, failed: 1, closedDaysAgo: 3 });
    }
    // The open window holding the real traffic.
    await window(owner, { status: 'OPEN', verified: 87, failed: 2 });

    const quality = await windows.qualityByProvider([owner.providerId], now);

    expect(quality.get(owner.providerId)).toEqual({
      providerId: owner.providerId,
      verifiedCalls: 95,
      failedCalls: 10,
    });
  });

  it('leaves out windows that closed more than 30 days ago', async () => {
    const owner = await providerWithBinding();
    await window(owner, { status: 'CLOSED', verified: 400, failed: 200, closedDaysAgo: 31 });
    await window(owner, { status: 'CLOSED', verified: 400, failed: 4, closedDaysAgo: 29 });

    const quality = await windows.qualityByProvider([owner.providerId], now);

    expect(quality.get(owner.providerId)).toMatchObject({ verifiedCalls: 400, failedCalls: 4 });
  });

  it('has no row for a provider measured on nothing in the period', async () => {
    const stale = await providerWithBinding();
    await window(stale, { status: 'CLOSED', verified: 10, failed: 0, closedDaysAgo: 45 });
    const unknown = randomUUID();

    const quality = await windows.qualityByProvider([stale.providerId, unknown], now);

    expect(quality.has(stale.providerId)).toBe(false);
    expect(quality.has(unknown)).toBe(false);
  });

  it('keeps providers apart', async () => {
    const a = await providerWithBinding();
    const b = await providerWithBinding();
    await window(a, { status: 'OPEN', verified: 10, failed: 1 });
    await window(b, { status: 'CLOSED', verified: 20, failed: 0, closedDaysAgo: 2 });

    const quality = await windows.qualityByProvider([a.providerId, b.providerId], now);

    expect(quality.get(a.providerId)).toMatchObject({ verifiedCalls: 10, failedCalls: 1 });
    expect(quality.get(b.providerId)).toMatchObject({ verifiedCalls: 20, failedCalls: 0 });
  });
});
