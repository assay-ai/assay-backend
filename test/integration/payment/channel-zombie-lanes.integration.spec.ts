import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { VoucherChannelStatus } from '@database/postgres/entities/voucher-channel.entity';
import { VoucherChannelRepository } from '@database/postgres/repositories/voucher-channel.repository';

import { freshMigratedDatabase, runDatabaseName } from '../helpers/slash-prorata-context';
import { testConnectionOptions } from '../helpers/test-database';

/**
 * Final review 2026-11-01 MF-3: a lane whose LAST admitted call never got
 * served (EXPIRED / VOIDED tail) keeps `last_accepted > settled` forever (no
 * round settles a zero-charge step). Such a lane, once CLOSED, must leave the
 * scheduler's list, its stale `deadline_at` must not rank it first, and a new
 * lane must be listed whatever the number of old lanes (the LIMIT is 2,000 in
 * production; 2 here).
 */
const DATABASE = 'goassay_mf3_zombie';
const CHAIN = 'eip155:46630';
const ASSET = `${CHAIN}/erc20:0x7e99c98e066032b2ef5768ff18ed090e1ab921ac`;

describe('MF-3 zombie lanes never starve the scheduler list', () => {
  let ds: DataSource;
  let channels: VoucherChannelRepository;
  const org = randomUUID();

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

  async function lane(over: Record<string, unknown>): Promise<string> {
    const payer = `${CHAIN}:0x${randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40)}`;
    const row = await channels.insertLane(ds.manager, {
      chainId: CHAIN,
      assetId: ASSET,
      payer,
      signer: payer,
      providerAccount: `${CHAIN}:0x${'bb'.repeat(20)}`,
      providerId: randomUUID(),
      channelId: `0x${randomUUID().replace(/-/g, '').padEnd(64, '0')}`,
      channelKey: `0x${randomUUID().replace(/-/g, '').padEnd(64, '1')}`,
      organizationId: org,
      agentId: randomUUID(),
      credentialId: null,
      ...over,
    } as never);
    return row.id;
  }

  async function call(
    channelRowId: string,
    cumulative: number,
    status: string,
    holdOpen: boolean,
    extra = '',
  ) {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO payment_intents (
         id, organization_id, status, agent_id, agent_account, provider_id, provider_account,
         tool_id, rail, call_id, call_class, asset_id, decimals, price_amount, provider_amount,
         platform_fee, request_hash, chain_id, expires_at, hold_id, hold_released_at,
         voucher_format, channel_row_id, channel_cumulative, channel_calls, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RAIL_B_VOUCHER', $9, 'PAID', $10, 6, 100000, 90000,
               10000, $11, $12, now(), $13, $14, 'CHANNEL', $15, $16, $17, now() - interval '3 hours')`,
      [
        id,
        org,
        status,
        randomUUID(),
        `${CHAIN}:0x${'aa'.repeat(20)}`,
        randomUUID(),
        `${CHAIN}:0x${'bb'.repeat(20)}`,
        randomUUID(),
        randomUUID(),
        ASSET,
        `sha256:${'ab'.repeat(32)}`,
        CHAIN,
        randomUUID(),
        holdOpen ? null : new Date(),
        channelRowId,
        String(cumulative),
        cumulative / 100000,
      ],
    );
    if (extra) await ds.query(`UPDATE payment_intents SET ${extra} WHERE id = $1`, [id]);
    return id;
  }

  it('more zombies than the limit: CLOSED, deadline cleared, unlisted; the new lane is processed', async () => {
    const zombies: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await lane({
        lastAcceptedCumulative: '200000',
        lastAcceptedCalls: 2,
        settledCumulative: '100000',
        settledCalls: 1,
        // Set by the round while call 1 was pending.
        deadlineAt: new Date(Date.now() - (10 - i) * 86_400_000),
      });
      await call(id, 100000, 'SETTLED', false); // collected long ago (hold committed)
      await call(id, 200000, i % 2 === 0 ? 'VOIDED' : 'EXPIRED', false);
      zombies.push(id);
    }
    await ds.query(`UPDATE voucher_channels SET updated_at = now() - interval '2 hours'`);
    expect(await channels.closeIdle(ASSET)).toBe(3);
    const closed = await ds.query(
      `SELECT status, deadline_at FROM voucher_channels WHERE id = ANY($1::uuid[])`,
      [zombies],
    );
    expect(closed.every((r: { status: string }) => r.status === VoucherChannelStatus.CLOSED)).toBe(
      true,
    );
    expect(closed.every((r: { deadline_at: Date | null }) => r.deadline_at === null)).toBe(true);

    // Old lanes still holding money (HELD, nothing pending, stale deadline): listed, but behind.
    const holding: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await lane({
        lastAcceptedCumulative: '100000',
        lastAcceptedCalls: 1,
        settledCumulative: '100000',
        settledCalls: 1,
        deadlineAt: new Date(Date.now() - (20 - i) * 86_400_000),
      });
      await call(id, 100000, 'SETTLED', true);
      await ds.query(
        `UPDATE payment_intents SET held_status = 'HELD', held_at = now(), collectable_at = now()
          WHERE channel_row_id = $1`,
        [id],
      );
      holding.push(id);
    }

    // A new lane with a served, unsettled call (buyer hold open), no deadline yet.
    const fresh = await lane({ lastAcceptedCumulative: '100000', lastAcceptedCalls: 1 });
    await call(fresh, 100000, 'SETTLED', true);

    const all = (await channels.listActive(ASSET)).map((c) => c.id);
    for (const z of zombies) expect(all).not.toContain(z);
    expect(all[0]).toBe(fresh);
    expect(all).toEqual(expect.arrayContaining(holding));
    // With the scheduler's limit the new lane is still listed (first).
    const limited = (await channels.listActive(ASSET, 2)).map((c) => c.id);
    expect(limited[0]).toBe(fresh);
  });

  it('fix review FR-M1: old lanes holding only a lapsed buyer debt do not starve a new lane', async () => {
    await ds.query(`DELETE FROM payment_intents; DELETE FROM voucher_channels;`);
    for (let i = 0; i < 3; i += 1) {
      const id = await lane({
        lastAcceptedCumulative: '200000',
        lastAcceptedCalls: 2,
        settledCumulative: '100000',
        settledCalls: 1,
        deadlineAt: null,
      });
      await ds.query(
        `UPDATE voucher_channels SET created_at = now() - interval '5 days' WHERE id = $1`,
        [id],
      );
      await call(id, 100000, 'SETTLED', false);
      // Lapsed into a buyer debt: the hold stays open until renewed or replaced.
      await call(id, 200000, 'SETTLED', true, `redemption_lapsed_at = now() - interval '4 days'`);
    }
    const fresh = await lane({
      lastAcceptedCumulative: '100000',
      lastAcceptedCalls: 1,
      settledCumulative: '0',
      settledCalls: 0,
      deadlineAt: new Date(Date.now() + 30 * 60_000),
    });
    await call(fresh, 100000, 'SETTLED', true);
    await ds.query(`UPDATE voucher_channels SET updated_at = now() - interval '2 hours'`);
    // closeIdle cannot close the debt lanes (their hold is open)...
    expect(await channels.closeIdle(ASSET)).toBe(0);
    // ...but the new lane with money to settle still comes first.
    const top = (await channels.listActive(ASSET, 2)).map((c) => c.id);
    expect(top[0]).toBe(fresh);
    // The debt lanes stay listed (after it).
    expect((await channels.listActive(ASSET, 10)).length).toBe(4);
  });

  it('a CLOSED lane with a chargeable unsettled call stays listed', async () => {
    const id = await lane({
      lastAcceptedCumulative: '100000',
      lastAcceptedCalls: 1,
      settledCumulative: '0',
      settledCalls: 0,
    });
    await call(id, 100000, 'SETTLED', true);
    await ds.query(`UPDATE voucher_channels SET status = 'CLOSED' WHERE id = $1`, [id]);
    expect((await channels.listActive(ASSET)).map((c) => c.id)).toContain(id);
    // Voided by the platform: nothing left to do.
    await ds.query(
      `UPDATE payment_intents SET redemption_last_error = 'voided:CHANNEL_UNSETTLED' WHERE channel_row_id = $1`,
      [id],
    );
    expect((await channels.listActive(ASSET)).map((c) => c.id)).not.toContain(id);
  });
  it('ops F2 / MF-9: the deadline alert reads the database; the last landed rate is read back', async () => {
    const id = await lane({
      lastAcceptedCumulative: '100000',
      lastAcceptedCalls: 1,
      settledCumulative: '0',
      settledCalls: 0,
      deadlineAt: new Date(Date.now() + 10 * 60_000),
    });
    await call(id, 100000, 'SETTLED', true);
    const [{ channel_key: key }] = await ds.query(
      `SELECT channel_key FROM voucher_channels WHERE id = $1`,
      [id],
    );
    expect(await channels.nearDeadline(ASSET, 45 * 60)).toContain(key);
    expect(await channels.nearDeadline(ASSET, 60)).not.toContain(key);
    expect(await channels.lastLandedRate(ASSET)).toBeNull();
  });
});
