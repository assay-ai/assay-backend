import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { getAddress } from 'viem';

import { VoucherChannelRepository } from '@database/postgres/repositories/voucher-channel.repository';

import { freshMigratedDatabase, runDatabaseName } from '../helpers/slash-prorata-context';
import { testConnectionOptions } from '../helpers/test-database';

/**
 * Final review 2026-11-01 backend F2 / F3: the payer and lane lookups no
 * longer wrap columns in `lower()` (which forced sequential scans on every
 * `GET /escrow` and every channel admission). Behaviour pinned here:
 *
 * - `payerPending` compares `agent_account` exactly, the stored session
 *   spelling, as the admission reservation (`readVoucherAdmission`) does;
 * - `lockLane` finds the lane by `(chain_id, channel_key)`, its unique index,
 *   whatever spelling the caller holds;
 * - `countOpen` and `requestUrgent` by payer still match every spelling of
 *   the same eip155 wallet (the open-lane cap is per wallet), through an
 *   indexable `= ANY(spellings)`.
 */
const DATABASE = 'assay_channel_payer_lookups_test';
const CHAIN = 'eip155:46630';
const ASSET = `${CHAIN}/erc20:0x7e99c98e066032b2ef5768ff18ed090e1ab921ac`;

describe('channel payer and lane lookups, against a real database', () => {
  let ds: DataSource;
  let channels: VoucherChannelRepository;

  beforeAll(async () => {
    ds = await freshMigratedDatabase(DATABASE);
    channels = new VoucherChannelRepository(ds);
    await ds.query(`ALTER TABLE payment_intents DISABLE TRIGGER ALL`);
    await ds.query(`ALTER TABLE payment_intents ENABLE TRIGGER USER`);
  }, 300_000);
  afterAll(async () => {
    await ds?.destroy();
    const c = testConnectionOptions();
    const admin = new Client({
      host: c.host,
      port: c.port,
      user: c.username,
      password: c.password,
      database: 'postgres',
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${runDatabaseName(DATABASE)}" WITH (FORCE)`);
    await admin.end();
  });

  /** A fresh wallet, as its checksummed CAIP-10 spelling (what sessions store). */
  function wallet(): { checksummed: string; lower: string; upper: string } {
    const hex = randomUUID().replace(/-/g, '').padEnd(40, 'a').slice(0, 40);
    const address = getAddress(`0x${hex}`);
    return {
      checksummed: `${CHAIN}:${address}`,
      lower: `${CHAIN}:${address.toLowerCase()}`,
      upper: `${CHAIN}:0x${address.slice(2).toUpperCase()}`,
    };
  }

  async function lane(payer: string): Promise<{ id: string; key: string; channelId: string }> {
    const channelId = `0x${randomUUID().replace(/-/g, '').padEnd(64, '0')}`;
    const key = `0x${randomUUID().replace(/-/g, '').padEnd(64, '1')}`;
    const row = await channels.insertLane(ds.manager, {
      chainId: CHAIN,
      assetId: ASSET,
      payer,
      signer: payer,
      providerAccount: `${CHAIN}:0x${'bb'.repeat(20)}`,
      providerId: randomUUID(),
      channelId,
      channelKey: key,
      organizationId: randomUUID(),
      agentId: randomUUID(),
      credentialId: null,
    } as never);
    return { id: row.id, key, channelId };
  }

  async function pendingCall(
    agentAccount: string,
    price: number,
    held: { status: 'HELD' | 'COLLECTED' | 'REFUNDED'; collectableAt: Date } | null = null,
  ): Promise<string> {
    const id = randomUUID();
    const channel = await lane(agentAccount);
    await ds.query(
      `INSERT INTO payment_intents (
         id, organization_id, status, agent_id, agent_account, provider_id, provider_account,
         tool_id, rail, call_id, call_class, asset_id, decimals, price_amount, provider_amount,
         platform_fee, request_hash, chain_id, expires_at, hold_id, voucher_format,
         channel_row_id, channel_cumulative, channel_calls, created_at)
       VALUES ($1, $2, 'SETTLED', $3, $4, $5, $6, $7, 'RAIL_B_VOUCHER', $8, 'PAID', $9, 6, $10, $10,
               0, $11, $12, now(), $13, 'CHANNEL', $14, $10, 1, now() - interval '1 hour')`,
      [
        id,
        randomUUID(),
        randomUUID(),
        agentAccount,
        randomUUID(),
        `${CHAIN}:0x${'bb'.repeat(20)}`,
        randomUUID(),
        randomUUID(),
        ASSET,
        String(price),
        `sha256:${'ab'.repeat(32)}`,
        CHAIN,
        randomUUID(),
        channel.id,
      ],
    );
    if (held) {
      await ds.query(
        `UPDATE payment_intents
            SET held_status = $2::varchar, held_at = now(), collectable_at = $3,
                hold_released_at = CASE WHEN $2::varchar = 'HELD' THEN NULL ELSE now() END
          WHERE id = $1`,
        [id, held.status, held.collectableAt],
      );
    }
    return id;
  }

  it('payerPending compares the stored agent_account spelling exactly (as the reservation guard)', async () => {
    const w = wallet();
    await pendingCall(w.checksummed, 100_000);
    await pendingCall(w.checksummed, 50_000);

    const exact = await channels.payerPending(w.checksummed, ASSET);
    expect(exact).toMatchObject({ amount: 150_000n, calls: 2 });

    // Another spelling is another reservation scope for the admission guard
    // (`agent_account = $1`); the escrow figure follows the same rule.
    const other = await channels.payerPending(w.lower, ASSET);
    expect(other).toMatchObject({ amount: 0n, calls: 0 });
  });

  it('payerPending splits calls in the on-chain hold from the unsettled ones (BUG-R2-BUY-01)', async () => {
    const w = wallet();
    const early = new Date(Date.now() + 30 * 60_000);
    const late = new Date(Date.now() + 90 * 60_000);
    await pendingCall(w.checksummed, 10_000);
    await pendingCall(w.checksummed, 20_000, { status: 'HELD', collectableAt: early });
    await pendingCall(w.checksummed, 30_000, { status: 'HELD', collectableAt: late });
    await pendingCall(w.checksummed, 40_000, { status: 'COLLECTED', collectableAt: early });
    await pendingCall(w.checksummed, 50_000, { status: 'REFUNDED', collectableAt: early });

    const figures = await channels.payerPending(w.checksummed, ASSET);
    expect(figures).toMatchObject({
      amount: 10_000n,
      calls: 1,
      onChainHeld: 50_000n,
      onChainHeldCalls: 2,
    });
    expect(figures.onChainHoldEndsAt?.getTime()).toBe(late.getTime());

    const none = await channels.payerPending(wallet().checksummed, ASSET);
    expect(none).toMatchObject({ onChainHeld: 0n, onChainHeldCalls: 0, onChainHoldEndsAt: null });
  });

  it('lockLane finds the lane by (chain_id, channel_key) whatever spelling the caller holds', async () => {
    const w = wallet();
    const stored = await lane(w.checksummed);
    const found = await ds.transaction(async (manager) =>
      channels.lockLane(
        manager,
        {
          chainId: CHAIN,
          payer: w.lower,
          signer: w.upper,
          providerAccount: `${CHAIN}:0x${'BB'.repeat(20)}`,
          channelId: stored.channelId.toUpperCase().replace('0X', '0x'),
        },
        stored.key.toUpperCase().replace('0X', '0x') as `0x${string}`,
      ),
    );
    expect(found?.id).toBe(stored.id);

    const missing = await ds.transaction(async (manager) =>
      channels.lockLane(
        manager,
        {
          chainId: CHAIN,
          payer: w.checksummed,
          signer: w.checksummed,
          providerAccount: `${CHAIN}:0x${'bb'.repeat(20)}`,
          channelId: stored.channelId,
        },
        `0x${'f'.repeat(64)}`,
      ),
    );
    expect(missing).toBeNull();
  });

  it('countOpen counts the lanes of every spelling of the same wallet (the per-wallet cap)', async () => {
    const w = wallet();
    const a = await lane(w.checksummed);
    const b = await lane(w.lower);
    await ds.query(`UPDATE voucher_channels SET status = 'ROTATED' WHERE id = ANY($1::uuid[])`, [
      [a.id, b.id],
    ]);
    for (const spelling of [w.checksummed, w.lower, w.upper]) {
      expect(await channels.countOpen(ds.manager, spelling, ASSET)).toBe(2);
    }
    expect(await channels.countOpen(ds.manager, wallet().checksummed, ASSET)).toBe(0);
  });

  it('requestUrgent by payer marks the pending lanes of every spelling of the wallet', async () => {
    const w = wallet();
    const a = await lane(w.checksummed);
    const b = await lane(w.lower);
    const idle = await lane(w.checksummed);
    await ds.query(
      `UPDATE voucher_channels SET last_accepted_cumulative = 100, last_accepted_calls = 1
        WHERE id = ANY($1::uuid[])`,
      [[a.id, b.id]],
    );
    await channels.requestUrgent({ payer: w.upper, assetId: ASSET }, 'RESERVATION');
    const rows = (await ds.query(
      `SELECT id, urgent_reason FROM voucher_channels WHERE id = ANY($1::uuid[])`,
      [[a.id, b.id, idle.id]],
    )) as { id: string; urgent_reason: string | null }[];
    const reason = new Map(rows.map((r) => [r.id, r.urgent_reason]));
    expect(reason.get(a.id)).toBe('RESERVATION');
    expect(reason.get(b.id)).toBe('RESERVATION');
    expect(reason.get(idle.id)).toBeNull();
  });
});
