import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { VoucherChannelRepository } from '@database/postgres/repositories/voucher-channel.repository';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * The channel door's data model and SQL against a real Postgres
 * (`1793404800000-channel-vouchers`, SPEC-W2 §4): the format CHECK and its
 * immutability, the routing of per-call queues away from channel rows, the
 * per-account held figure across both doors, the ONE reservation under the
 * payer's advisory lock across two providers and both doors, and the
 * scheduler's booking SQL.
 */
const DATABASE = 'assay_channel_vouchers_test';
const CHAIN = 'eip155:46630';
const ASSET = `${CHAIN}/erc20:0x7e99c98e066032b2ef5768ff18ed090e1ab921ac`;

describe('channel vouchers, against a real database', () => {
  let dataSource: DataSource;
  let payments: PaymentIntentRepository;
  let channels: VoucherChannelRepository;
  let org: string;
  let payer: string;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    payments = new PaymentIntentRepository(dataSource);
    channels = new VoucherChannelRepository(dataSource);
    await dataSource.query(`ALTER TABLE payment_intents DISABLE TRIGGER ALL`);
    await dataSource.query(`ALTER TABLE payment_intents ENABLE TRIGGER USER`);
  }, 300_000);
  afterAll(async () => dataSource?.destroy());

  beforeEach(() => {
    org = randomUUID();
    payer = `${CHAIN}:0x${randomUUID().replace(/-/g, '').padStart(40, '0').slice(0, 40)}`;
  });

  async function lane(provider = `${CHAIN}:0x${'bb'.repeat(20)}`): Promise<string> {
    const row = await channels.insertLane(dataSource.manager, {
      chainId: CHAIN,
      assetId: ASSET,
      payer,
      signer: payer,
      providerAccount: provider,
      providerId: randomUUID(),
      channelId: `0x${randomUUID().replace(/-/g, '').padEnd(64, '0')}`,
      channelKey: `0x${randomUUID().replace(/-/g, '').padEnd(64, '1')}`,
      organizationId: org,
      agentId: randomUUID(),
      credentialId: null,
    });
    return row.id;
  }

  async function seed(options: {
    format: 'PER_CALL' | 'CHANNEL';
    channelRowId?: string;
    cumulative?: bigint;
    status?: string;
    held?: boolean;
    price?: number;
    hold?: boolean;
    created?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    const channel = options.format === 'CHANNEL';
    await dataSource.query(
      `INSERT INTO payment_intents (
         id, organization_id, status, agent_id, agent_account, provider_id, provider_account,
         tool_id, rail, call_id, call_class, asset_id, decimals, price_amount, provider_amount,
         platform_fee, request_hash, chain_id, expires_at, voucher_seq, voucher_signature,
         hold_id, held_status, held_at, collectable_at, voucher_format, channel_row_id,
         channel_cumulative, channel_calls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RAIL_B_VOUCHER', $9, 'PAID', $10, 6, $11, $12, $13,
               $14, $15, now() + interval '5 minutes', $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
      [
        id,
        org,
        options.status ?? 'SETTLED',
        randomUUID(),
        payer,
        randomUUID(),
        `${CHAIN}:0x${'bb'.repeat(20)}`,
        randomUUID(),
        randomUUID(),
        ASSET,
        options.price ?? 1000,
        (options.price ?? 1000) - 100,
        100,
        `sha256:${'ab'.repeat(32)}`,
        CHAIN,
        channel ? null : String(Math.floor(Math.random() * 1e9)),
        channel ? null : `0x${'12'.repeat(65)}`,
        options.hold === false ? null : randomUUID(),
        options.held ? 'HELD' : null,
        options.held ? new Date() : null,
        options.held ? new Date(Date.now() - 1000) : null,
        options.format,
        channel ? options.channelRowId : null,
        channel ? String(options.cumulative ?? 1000n) : null,
        channel ? Number((options.cumulative ?? 1000n) / 1000n) : null,
      ],
    );
    return id;
  }

  it('a CHANNEL row needs its channel position and no seq; a PER_CALL row has no channel columns', async () => {
    const id = await lane();
    await expect(
      dataSource.query(
        `INSERT INTO payment_intents (id, organization_id, status, agent_id, agent_account, tool_id, rail,
           call_id, call_class, asset_id, decimals, price_amount, provider_amount, platform_fee,
           request_hash, chain_id, expires_at, voucher_format, voucher_seq)
         VALUES ($1, $2, 'CREATED', $3, $4, $8, 'RAIL_B_VOUCHER', $9, 'PAID', $5, 6, 1, 1, 0,
           $6, $7, now(), 'CHANNEL', 5)`,
        [
          randomUUID(),
          org,
          randomUUID(),
          payer,
          ASSET,
          `sha256:${'ab'.repeat(32)}`,
          CHAIN,
          randomUUID(),
          randomUUID(),
        ],
      ),
    ).rejects.toThrow(/chk_payment_intents_voucher_format/);
    const row = await seed({ format: 'CHANNEL', channelRowId: id });
    await expect(
      dataSource.query(`UPDATE payment_intents SET channel_cumulative = 999 WHERE id = $1`, [row]),
    ).rejects.toThrow(/immutable/);
  });

  it('per-call queues never see a channel row; the per-account held figure counts both doors', async () => {
    const id = await lane();
    await seed({ format: 'CHANNEL', channelRowId: id, held: true, price: 3000 });
    await seed({ format: 'PER_CALL', held: true, price: 1000 });

    const collectable = await payments.findCollectable('RAIL_B_VOUCHER', 500);
    expect(collectable.filter((r) => r.organizationId === org).map((r) => r.voucherFormat)).toEqual(
      ['PER_CALL'],
    );
    expect((await payments.sumHeldOnChainByAccounts(ASSET, [payer])).get(payer)).toBe(4000n);
    // The global mirrors split by door: `totalHeld()` vs `channelBooks.held`.
    expect(await payments.sumChannelHeldOnChain(ASSET)).toBeGreaterThanOrEqual(3000n);
  });

  it('ONE reservation, atomic under the payer lock, across two providers and both doors', async () => {
    // Balance 5,000; six concurrent admissions of 1,000 each (channel A, channel B,
    // per-call), each counting everything promised and not yet holding.
    const balance = 5_000n;
    const already = await seed({ format: 'PER_CALL', status: 'CREATED', hold: false, price: 1000 });
    expect(already).toBeDefined();
    const lanes = [
      await lane(`${CHAIN}:0x${'b1'.repeat(20)}`),
      await lane(`${CHAIN}:0x${'b2'.repeat(20)}`),
    ];
    const attempts = Array.from({ length: 6 }, (_, i) => {
      const format = i % 3 === 2 ? 'PER_CALL' : 'CHANNEL';
      const row: Record<string, unknown> = {
        id: randomUUID(),
        organizationId: org,
        status: 'CREATED',
        agentId: randomUUID(),
        agentAccount: payer,
        toolId: randomUUID(),
        rail: 'RAIL_B_VOUCHER',
        callId: randomUUID(),
        callClass: 'PAID',
        assetId: ASSET,
        decimals: 6,
        priceAmount: '1000',
        providerAmount: '900',
        platformFee: '100',
        requestHash: `sha256:${'ab'.repeat(32)}`,
        chainId: CHAIN,
        expiresAt: new Date(Date.now() + 300_000),
        voucherFormat: format,
        ...(format === 'CHANNEL'
          ? {
              channelRowId: lanes[i % 2],
              channelCumulative: String(1000 * (i + 1)),
              channelCalls: i + 1,
            }
          : { voucherSeq: String(10_000 + i), voucherSignature: `0x${'12'.repeat(65)}` }),
      };
      return payments
        .insertAdmittedVoucherIntent(
          row as never,
          { payer, assetId: ASSET, delegate: null, escrowSince: new Date(), organizationId: org },
          (open) => {
            if ((open.reserved ?? 0n) + 1000n > balance) throw new Error('INSUFFICIENT');
          },
        )
        .then(
          () => 'admitted',
          (error: Error) => error.message,
        );
    });
    const results = await Promise.all(attempts);
    // 1,000 was already promised: exactly four fit, whoever wins.
    expect(results.filter((r) => r === 'admitted')).toHaveLength(4);
    expect(results.filter((r) => r === 'INSUFFICIENT')).toHaveLength(2);
  });

  it('pending, open count, booking at the settle rate, lapse and close', async () => {
    const id = await lane();
    const a = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
    const b = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 2000n });
    await dataSource.query(
      `UPDATE voucher_channels SET last_accepted_cumulative = 2000, last_accepted_calls = 2 WHERE id = $1`,
      [id],
    );
    expect(await channels.pendingOf(dataSource.manager, id)).toBe(2000n);
    expect(await channels.countOpen(dataSource.manager, payer, ASSET)).toBe(1);

    const booked = await dataSource.transaction((manager) =>
      channels.bookCharged(manager, id, [a], new Date(), new Date(Date.now() + 3_600_000), 1_250),
    );
    expect(booked).toBe(1);
    const [row] = await dataSource.query(
      `SELECT held_status, platform_fee::text AS fee, provider_amount::text AS provider FROM payment_intents WHERE id = $1`,
      [a],
    );
    expect(row).toEqual({ held_status: 'HELD', fee: '125', provider: '875' });

    expect(await channels.lapse(id, [b], 'ChannelVoucherExpired')).toBe(1);
    expect(await channels.markReplaced(id, 2000n)).toBe(1);
    // Nothing closes while a call is held.
    expect(await channels.closeIdle(ASSET)).toBe(0);
  });

  it('a bound settlement blocks a second one; releasing it unbinds the rows', async () => {
    const id = await lane();
    const v = await channels.insertVoucher(dataSource.manager, {
      channelRowId: id,
      intentId: null,
      cumulative: '1000',
      calls: 1,
      issuedAt: '1800000000',
      expiresAt: '1800000240',
      signature: `0x${'11'.repeat(65)}`,
    });
    await dataSource.query(
      `UPDATE voucher_channels SET last_accepted_cumulative = 1000, last_accepted_calls = 1 WHERE id = $1`,
      [id],
    );
    const call = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
    const input = {
      channelRowId: id,
      voucherId: v,
      fromSettled: 0n,
      toCumulative: 1000n,
      fromCalls: 0,
      toCalls: 1,
      charge: 1000n,
      waived: 0n,
      trigger: 'AGE',
      intentIds: [call],
    };
    const first = await channels.bindSettlement(input);
    expect(first).not.toBeNull();
    expect(await channels.bindSettlement(input)).toBeNull();
    await channels.releaseSettlement(first!, 'DROPPED' as never, 'test');
    const [after] = await dataSource.query(
      `SELECT channel_settlement_id FROM payment_intents WHERE id = $1`,
      [call],
    );
    expect(after.channel_settlement_id).toBeNull();
    expect(await channels.bindSettlement(input)).not.toBeNull();
  });

  it('a drain and a pre-slash request mark only channels with value to settle; asking twice is idempotent', async () => {
    const pendingLane = await lane();
    const idleLane = await lane(`${CHAIN}:0x${'b9'.repeat(20)}`);
    await seed({ format: 'CHANNEL', channelRowId: pendingLane, cumulative: 1000n });
    await dataSource.query(
      `UPDATE voucher_channels SET last_accepted_cumulative = 1000, last_accepted_calls = 1 WHERE id = $1`,
      [pendingLane],
    );
    expect(await channels.requestDrain(dataSource.manager, ASSET)).toBeGreaterThanOrEqual(1);
    const [marked] = await dataSource.query(
      `SELECT urgent_reason, urgent_requested_at FROM voucher_channels WHERE id = $1`,
      [pendingLane],
    );
    expect(marked.urgent_reason).toBe('DRAIN');
    const first = marked.urgent_requested_at;
    await channels.requestDrain(dataSource.manager, ASSET);
    const [again] = await dataSource.query(
      `SELECT urgent_requested_at FROM voucher_channels WHERE id = $1`,
      [pendingLane],
    );
    expect(again.urgent_requested_at).toEqual(first);
    const [idle] = await dataSource.query(
      `SELECT urgent_reason FROM voucher_channels WHERE id = $1`,
      [idleLane],
    );
    expect(idle.urgent_reason).toBeNull();

    const [{ provider_id: providerId }] = await dataSource.query(
      `SELECT provider_id FROM voucher_channels WHERE id = $1`,
      [pendingLane],
    );
    expect(await channels.requestProviderSettle(providerId, CHAIN, 'SLASH')).toBe(1);
  });

  it('refund volume per provider per hour: held in the hour vs refunded out of the hold', async () => {
    const held = await seed({ format: 'PER_CALL', held: true, price: 4000 });
    const refunded = await seed({ format: 'PER_CALL', held: true, price: 3000 });
    await dataSource.query(
      `UPDATE payment_intents SET held_status = 'REFUNDED', hold_released_at = now() WHERE id = $1`,
      [refunded],
    );
    const [{ provider_id: a }] = await dataSource.query(
      `SELECT provider_id FROM payment_intents WHERE id = $1`,
      [held],
    );
    const [{ provider_id: b }] = await dataSource.query(
      `SELECT provider_id FROM payment_intents WHERE id = $1`,
      [refunded],
    );
    const rows = await payments.refundVolumeByProvider(3_600);
    expect(rows.find((r) => r.providerId === a)).toMatchObject({ held: 4000n, refunded: 0n });
    expect(rows.find((r) => r.providerId === b)).toMatchObject({
      held: 3000n,
      refunded: 3000n,
      refunds: 1,
    });
  });

  describe('review 2026-10-31 fixes', () => {
    it('closeUnsettled marks forfeit or void once and hands back the holds; calls() reports it closed', async () => {
      const id = await lane();
      const a = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
      const first = await channels.closeUnsettled(id, [a], 'provider_forfeit:ChannelStake');
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ intentId: a, organizationId: org });
      // A crash before the release: asked again, the same row (and mark) come back.
      const again = await channels.closeUnsettled(id, [a], 'voided:CHANNEL_SEND_FAILED');
      expect(again).toHaveLength(1);
      const [row] = await dataSource.query(
        `SELECT redemption_last_error FROM payment_intents WHERE id = $1`,
        [a],
      );
      expect(row.redemption_last_error).toBe('provider_forfeit:ChannelStake');
      const [record] = await channels.calls(id);
      expect(record).toMatchObject({ closed: true, holdOpen: true });
    });

    it('one live refund per call; a dropped one may be sent again', async () => {
      const intentId = randomUUID();
      const input = {
        kind: 'REFUND' as never,
        assetId: ASSET,
        intentId,
        channelRowIds: [await lane()],
        amount: 100n,
      };
      const first = await channels.insertTx(input);
      expect(first).not.toBeNull();
      expect(await channels.insertTx(input)).toBeNull();
      await channels.appendTxRef(first!, '0xabc');
      expect(await channels.findLiveRefund(intentId)).toMatchObject({
        status: 'SENT',
        txRefs: ['0xabc'],
        amount: 100n,
      });
      await channels.finishTx(first!, 'DROPPED' as never, 'mined, not refunded');
      expect(await channels.findLiveRefund(intentId)).toBeNull();
      expect(await channels.insertTx(input)).not.toBeNull();
    });

    it('final review MF-1: a PARTIAL piece frees the call for its next piece; the last piece LANDED blocks', async () => {
      const intentId = randomUUID();
      const base = {
        kind: 'REFUND' as never,
        assetId: ASSET,
        intentId,
        channelRowIds: [await lane()],
      };
      const first = await channels.insertTx({ ...base, amount: 50n, pieceIndex: 0 });
      await channels.appendTxRef(first!, '0xp0');
      // A re-sent piece the chain answered AlreadyRefunded: booked at what its landing moved.
      await channels.finishTx(first!, 'PARTIAL' as never, 'already refunded', '0xp0', 60n);
      const second = await channels.insertTx({ ...base, amount: 90n, pieceIndex: 1 });
      expect(second).not.toBeNull();
      await channels.finishTx(second!, 'LANDED' as never, null, '0xp1');
      expect(await channels.insertTx({ ...base, amount: 1n, pieceIndex: 2 })).toBeNull();
      const records = await channels.refundRecords(intentId);
      expect(records.map((r) => [r.status, r.pieceIndex, r.amount])).toEqual([
        ['PARTIAL', 0, 60n],
        ['LANDED', 1, 90n],
      ]);
    });

    it('in-flight collects are listed until finished', async () => {
      const id = await lane();
      const tx = await channels.insertTx({
        kind: 'COLLECT' as never,
        assetId: ASSET,
        channelRowIds: [id],
      });
      expect(
        (await channels.findInFlightTxs(ASSET, 'COLLECT' as never)).map((t) => t.id),
      ).toContain(tx);
      await channels.finishTx(tx!, 'LANDED' as never, null, '0xdef');
      expect(
        (await channels.findInFlightTxs(ASSET, 'COLLECT' as never)).map((t) => t.id),
      ).not.toContain(tx);
    });

    it('unpaid payouts: recorded once, shown per provider, claimed on request', async () => {
      const providerId = randomUUID();
      const address = `0x${randomUUID().replace(/-/g, '').slice(0, 32)}${'ab'.repeat(4)}`;
      const event = {
        assetId: ASSET,
        address,
        providerId,
        amount: 180n,
        txRef: `0x${randomUUID()}`,
      };
      await channels.recordUnpaid(event);
      await channels.recordUnpaid(event);
      expect(await channels.unpaidOf(providerId, ASSET)).toMatchObject({ amount: 180n });
      // L-6: per asset, every asset.
      expect(await channels.unpaidByAsset(providerId)).toEqual([
        { assetId: ASSET, amount: 180n, since: expect.any(Date) },
      ]);
      expect(await channels.claimRequests(ASSET)).not.toContain(address.toLowerCase());
      expect(await channels.requestClaim(dataSource.manager, ASSET, address)).toBe(1);
      expect(await channels.claimRequests(ASSET)).toContain(address.toLowerCase());
      await channels.markClaimed(ASSET, address, '0xclaim');
      expect(await channels.unpaidOf(providerId, ASSET)).toMatchObject({ amount: 0n });
      expect(await channels.unpaidByAsset(providerId)).toEqual([]);
    });

    it('the foreign-scan cursor only moves forward', async () => {
      const asset = `${ASSET}-${randomUUID()}`;
      expect(await channels.scanCursor(asset)).toBeNull();
      await channels.setScanCursor(asset, 100n);
      await channels.setScanCursor(asset, 50n);
      expect(await channels.scanCursor(asset)).toBe(100n);
    });

    it('a repeated status write does not keep the lane fresh; a reconciler-stopped lane is not counted (L9)', async () => {
      const id = await lane();
      await channels.setStatus(id, 'DESYNC' as never, 'RECONCILE');
      await dataSource.query(
        `UPDATE voucher_channels SET updated_at = now() - interval '2 hours' WHERE id = $1`,
        [id],
      );
      await channels.setStatus(id, 'DESYNC' as never, 'RECONCILE');
      const [row] = await dataSource.query(
        `SELECT updated_at < now() - interval '1 hour' AS stale FROM voucher_channels WHERE id = $1`,
        [id],
      );
      expect(row.stale).toBe(true);
      expect(await channels.countOpen(dataSource.manager, payer, ASSET)).toBe(0);
      expect(await channels.closeIdle(ASSET)).toBeGreaterThanOrEqual(1);
    });

    it('a settlement keeps the calls it charged at bind; renew bookkeeping finds the lane’s debts', async () => {
      const id = await lane();
      const a = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
      const b = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 2000n });
      await dataSource.query(
        `UPDATE voucher_channels SET last_accepted_cumulative = 2000, last_accepted_calls = 2 WHERE id = $1`,
        [id],
      );
      const [voucher] = await dataSource.query(
        `INSERT INTO channel_vouchers (id, channel_row_id, intent_id, cumulative, calls, issued_at, expires_at, signature)
         VALUES ($1, $2, $3, 2000, 2, 1, 100, '0x00') RETURNING id`,
        [randomUUID(), id, b],
      );
      const settlement = await channels.bindSettlement({
        channelRowId: id,
        voucherId: voucher.id,
        fromSettled: 0n,
        toCumulative: 2000n,
        fromCalls: 0,
        toCalls: 2,
        charge: 1000n,
        waived: 1000n,
        trigger: 'AGE',
        intentIds: [a, b],
        chargedIntentIds: [a],
      });
      expect((await channels.findSettlement(settlement!))?.chargedIntentIds).toEqual([a]);
      await channels.releaseSettlement(settlement!, 'DROPPED' as never, 'test');
      expect((await channels.findReleasedTo(id, 2000n))?.id).toBe(settlement);

      expect(await channels.lapse(id, [b], 'ChannelVoucherExpired:Balance')).toBe(1);
      expect(await channels.lapsedDebtsUpTo(id, 2000n)).toEqual([
        { intentId: b, writtenOff: false, replaced: false },
      ]);
      expect(await channels.lastRenewAt(id)).toBeNull();
      expect(await channels.lastRenewAgeSeconds(id)).toBeNull();
      // A renew voucher (no intent): its age on the database clock (backend F5).
      await channels.insertVoucher(dataSource.manager, {
        channelRowId: id,
        intentId: null,
        cumulative: '2000',
        calls: 2,
        issuedAt: '1800000000',
        expiresAt: '1800000240',
        signature: `0x${'11'.repeat(65)}`,
      });
      const age = await channels.lastRenewAgeSeconds(id);
      expect(age).not.toBeNull();
      expect(age!).toBeGreaterThanOrEqual(0);
      expect(age!).toBeLessThan(60);
      // A re-signed copy of the same message is found as a replay (backend F4).
      expect(
        await channels.findReplay(id, 2000n, 2, {
          issuedAt: 1_800_000_000n,
          expiresAt: 1_800_000_240n,
        }),
      ).toMatchObject({ intentId: null });
      expect(
        await channels.findReplay(id, 2000n, 2, {
          issuedAt: 1_800_000_000n,
          expiresAt: 1_800_000_200n,
        }),
      ).toBeNull();
      // The debt names its lane, so a client renews on that lane only (client review M-1).
      const [{ channel_id: laneChannelId }] = await dataSource.query(
        `SELECT channel_id FROM voucher_channels WHERE id = $1`,
        [id],
      );
      const debt = await payments.findOutstandingDebt(payer, b);
      expect(debt?.voucherFormat).toBe('CHANNEL');
      expect(debt?.channelId).toBe(laneChannelId);
      // Not written off: nothing to reopen.
      expect(await channels.markWrittenOffReplaced(id, b, randomUUID())).toBe(false);
      await channels.setLastSkip(id, 'Stake');
      await channels.setLastSkip(id, 'Stake');
      const [skip] = await dataSource.query(
        `SELECT last_skip_reason FROM voucher_channels WHERE id = $1`,
        [id],
      );
      expect(skip.last_skip_reason).toBe('Stake');
      await channels.setLastSkip(id, null);

      // The read models: the open debt is split out, the doors reported apart.
      const pending = await channels.payerPending(payer, ASSET);
      expect(pending.debt).toBe(1000n);
      expect(pending.amount).toBe(2000n);
      const [{ provider_id: providerId }] = await dataSource.query(
        `SELECT provider_id FROM payment_intents WHERE id = $1`,
        [a],
      );
      const stages = await channels.providerStages(providerId, ASSET);
      expect(stages.doors.channel.active).toBe(true);
      expect(stages.doors.perCall.ready).toBe(0n);
    });
  });

  describe('sec-audit 2026-11-01 fixes, against a real database', () => {
    it('calls() reports everLapsed (B-2) and the DB-clock age (B-L2)', async () => {
      const id = await lane();
      const a = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
      await dataSource.query(
        `UPDATE payment_intents SET created_at = now() - interval '400 seconds',
                redemption_lapsed_at = now(), redemption_replaced_at = now() WHERE id = $1`,
        [a],
      );
      const [record] = await channels.calls(id);
      expect(record.lapsed).toBe(false); // REPLACING
      expect(record.everLapsed).toBe(true);
      expect(record.ageSeconds).toBeGreaterThanOrEqual(399);
      expect(record.ageSeconds).toBeLessThan(500);
    });

    it('B-6: an uncharged T_term call is voided once, and a planned bind then refuses to charge it', async () => {
      const id = await lane();
      const a = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
      await dataSource.query(
        `UPDATE payment_intents SET status_reason = 'channel_terminal_timeout_unverified' WHERE id = $1`,
        [a],
      );
      const [row] = await dataSource.query(
        `SELECT hold_id, agent_account FROM payment_intents WHERE id = $1`,
        [a],
      );
      const target = {
        organizationId: org,
        id: a,
        payer: row.agent_account,
        holdId: row.hold_id,
        channelRowId: id,
      };
      const voidOnce = async () => {
        const runner = dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
          const done = await payments.markChannelCallVoided(
            runner,
            target,
            'voided:REFUND',
            'channel_terminal_timeout_unverified',
          );
          await runner.commitTransaction();
          return done;
        } finally {
          await runner.release();
        }
      };
      expect(await voidOnce()).toBe(true);
      expect(await voidOnce()).toBe(false);
      const [record] = await channels.calls(id);
      expect(record).toMatchObject({ closed: true, holdOpen: false });

      await dataSource.query(
        `UPDATE voucher_channels SET last_accepted_cumulative = 1000, last_accepted_calls = 1 WHERE id = $1`,
        [id],
      );
      const [voucher] = await dataSource.query(
        `INSERT INTO channel_vouchers (id, channel_row_id, intent_id, cumulative, calls, issued_at, expires_at, signature)
         VALUES ($1, $2, $3, 1000, 1, 1, 100, '0x00') RETURNING id`,
        [randomUUID(), id, a],
      );
      const bind = (trigger: string) =>
        channels.bindSettlement({
          channelRowId: id,
          voucherId: voucher.id,
          fromSettled: 0n,
          toCumulative: 1000n,
          fromCalls: 0,
          toCalls: 1,
          charge: 1000n,
          waived: 0n,
          trigger,
          intentIds: [a],
          chargedIntentIds: [a],
        });
      expect(await bind('AGE')).toBeNull();
      const [lane1] = await dataSource.query(
        `SELECT settling_to FROM voucher_channels WHERE id = $1`,
        [id],
      );
      expect(lane1.settling_to).toBeNull(); // rolled back
      // A RECOVER bind books what the chain already did: not refused.
      expect(await bind('RECOVER')).not.toBeNull();
    });

    it('B-6: a call already bound to a settlement is not voided (no longer free)', async () => {
      const id = await lane();
      const a = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
      await dataSource.query(
        `UPDATE payment_intents SET status_reason = 'channel_terminal_timeout_unverified' WHERE id = $1`,
        [a],
      );
      const [voucher] = await dataSource.query(
        `INSERT INTO channel_vouchers (id, channel_row_id, intent_id, cumulative, calls, issued_at, expires_at, signature)
         VALUES ($1, $2, $3, 1000, 1, 1, 100, '0x00') RETURNING id`,
        [randomUUID(), id, a],
      );
      await dataSource.query(
        `UPDATE voucher_channels SET last_accepted_cumulative = 1000, last_accepted_calls = 1 WHERE id = $1`,
        [id],
      );
      const bound = await channels.bindSettlement({
        channelRowId: id,
        voucherId: voucher.id,
        fromSettled: 0n,
        toCumulative: 1000n,
        fromCalls: 0,
        toCalls: 1,
        charge: 1000n,
        waived: 0n,
        trigger: 'AGE',
        intentIds: [a],
        chargedIntentIds: [a],
      });
      expect(bound).not.toBeNull();
      const [row] = await dataSource.query(
        `SELECT hold_id, agent_account FROM payment_intents WHERE id = $1`,
        [a],
      );
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        expect(
          await payments.markChannelCallVoided(
            runner,
            {
              organizationId: org,
              id: a,
              payer: row.agent_account,
              holdId: row.hold_id,
              channelRowId: id,
            },
            'voided:REFUND',
            'channel_terminal_timeout_unverified',
          ),
        ).toBe(false);
        await runner.commitTransaction();
      } finally {
        await runner.release();
      }
    });
  });

  describe('e2e bugs B-1, B-4 and the nonce rule, against a real database', () => {
    it('B-1: listActive runs on Postgres (property names before a line break are mapped)', async () => {
      const id = await lane();
      await dataSource.query(
        `UPDATE voucher_channels SET last_accepted_cumulative = 1000, last_accepted_calls = 1 WHERE id = $1`,
        [id],
      );
      const active = await channels.listActive(ASSET);
      expect(active.map((c) => c.id)).toContain(id);
      expect(await channels.activeAssets()).toContain(ASSET);
    });

    it('B-1: a whole scheduler pass completes on Postgres and settles an aged channel', async () => {
      const { ChannelSettlementService } =
        await import('@modules/payment/services/channel-settlement.service');
      const { DEFAULT_CHANNEL_POLICY } =
        await import('@modules/payment/domain/channel/channel-policy');
      const { EMPTY_SLOT } = await import('@modules/payment/domain/channel/channel-voucher');
      const asset = `${CHAIN}/erc20:0x${randomUUID().replace(/-/g, '').slice(0, 32)}${'cd'.repeat(4)}`;
      const row = await channels.insertLane(dataSource.manager, {
        chainId: CHAIN,
        assetId: asset,
        payer,
        signer: payer,
        providerAccount: `${CHAIN}:0x${'bb'.repeat(20)}`,
        providerId: randomUUID(),
        channelId: `0x${randomUUID().replace(/-/g, '').padEnd(64, '0')}`,
        channelKey: `0x${randomUUID().replace(/-/g, '').padEnd(64, '2')}`,
        organizationId: org,
        agentId: randomUUID(),
        credentialId: null,
      });
      const intentId = await seed({ format: 'CHANNEL', channelRowId: row.id, cumulative: 1000n });
      const now = Math.floor(Date.now() / 1000);
      await dataSource.query(
        `UPDATE payment_intents SET asset_id = $2, created_at = now() - interval '40 minutes' WHERE id = $1`,
        [intentId, asset],
      );
      await dataSource.query(
        `UPDATE voucher_channels SET last_accepted_cumulative = 1000, last_accepted_calls = 1 WHERE id = $1`,
        [row.id],
      );
      await dataSource.query(
        `INSERT INTO channel_vouchers (id, channel_row_id, intent_id, cumulative, calls, issued_at, expires_at, signature)
         VALUES ($1, $2, $3, 1000, 1, $4, $5, $6)`,
        [randomUUID(), row.id, intentId, now - 30, now + 200, `0x${'11'.repeat(65)}`],
      );
      const sent: unknown[] = [];
      const door = {
        doorLive: async () => true,
        chainNow: async () => now,
        collectHoldSeconds: async () => 3_600,
        takeRateBps: async () => 1_000,
        treasury: async () => `0x${'ee'.repeat(20)}`,
        isFrozen: async () => false,
        readBooks: async () => ({ slot: { ...EMPTY_SLOT }, unpaid: 0n, totalUnpaid: 0n, held: 0n }),
        signerWindow: async () => ({
          validUntil: null,
          revoked: false,
          revokeGraceEndsAt: null,
          heldCapsEndAt: null,
        }),
        providerRisk: async () => ({
          unbonding: false,
          slashPending: false,
          nearFloor: false,
          blocked: false,
        }),
        txReceipt: async () => ({ state: 'UNKNOWN' }),
        confirmedNonce: async () => 0n,
        simulateSettle: async (_a: unknown, items: any[]) =>
          items.map((item, index) => ({
            kind: 'SETTLED',
            index,
            key: '0x',
            cumulative: item.voucher.cumulative,
            calls: item.voucher.calls,
            charge: item.charge,
            maturityHour: 0,
            takeRateBps: 0,
            opened: null,
            deferred: null,
          })),
        settle: async (_a: unknown, items: any[], _lane: string, opts: any) => {
          sent.push(items.length);
          const hash = `0x${randomUUID().replace(/-/g, '')}`;
          await opts.beforeBroadcast(hash, { from: `0x${'90'.repeat(20)}`, nonce: 3n });
          return {
            txRef: hash,
            landedAt: now,
            outcomes: items.map((item, index) => ({
              kind: 'SETTLED',
              index,
              key: row.channelKey,
              cumulative: item.voucher.cumulative,
              calls: item.voucher.calls,
              charge: item.charge,
              maturityHour: Math.ceil((now + 3_600) / 3_600),
              takeRateBps: 1_000,
              opened: null,
              deferred: null,
            })),
          };
        },
      };
      const errors: string[] = [];
      const intents = {
        resolve: async () => undefined,
        findById: async () => null,
        releaseHold: async () => true,
        bookHeldCollected: async () => undefined,
        bookBlockedProviderRefund: async () => ({ booked: false, disputeIds: [] }),
      };
      const service = new ChannelSettlementService(
        channels,
        intents as never,
        door as never,
        { emit: async () => undefined } as never,
        new Set([CHAIN]),
        DEFAULT_CHANNEL_POLICY,
        null,
        () => Date.now(),
      );
      (service as any).logger = {
        error: (m: string) => errors.push(m),
        warn: () => undefined,
        debug: () => undefined,
        log: () => undefined,
      };
      expect(await service.assets()).toContain(asset);
      await service.run(asset as never);
      expect(errors).toEqual([]);
      expect(sent).toEqual([1]);
      const [held] = await dataSource.query(
        `SELECT held_status, channel_settlement_id FROM payment_intents WHERE id = $1`,
        [intentId],
      );
      expect(held.held_status).toBe('HELD');
      const [settlement] = await dataSource.query(
        `SELECT status, charge::text AS charge, collected::text AS collected, left_amount::text AS left_amount
           FROM channel_settlements WHERE id = $1`,
        [held.channel_settlement_id],
      );
      // B-4: the totals are written (nothing collected yet: all of it is left).
      expect(settlement).toEqual({
        status: 'LANDED',
        charge: '1000',
        collected: '0',
        left_amount: '1000',
      });
      // The sender + nonce were recorded with the hash before the "broadcast".
      const [attempt] = await dataSource.query(
        `SELECT nonce::text AS nonce FROM channel_tx_attempts ORDER BY recorded_at DESC LIMIT 1`,
      );
      expect(attempt.nonce).toBe('3');

      // B-4: once collected, the totals follow the booked calls.
      await dataSource.query(`UPDATE payment_intents SET held_status = 'COLLECTED' WHERE id = $1`, [
        intentId,
      ]);
      expect(await channels.refreshSettlementTotals(asset)).toBe(1);
      expect(await channels.refreshSettlementTotals(asset)).toBe(0);
      const [after] = await dataSource.query(
        `SELECT collected::text AS collected, left_amount::text AS left_amount FROM channel_settlements WHERE id = $1`,
        [held.channel_settlement_id],
      );
      expect(after).toEqual({ collected: '1000', left_amount: '0' });
    });

    it('attempts: sender and nonce kept per hash', async () => {
      const hash = `0x${randomUUID().replace(/-/g, '')}`;
      await channels.recordAttempt(hash, `0x${'AB'.repeat(20)}`, 12n);
      await channels.recordAttempt(hash, `0x${'AB'.repeat(20)}`, 13n);
      expect((await channels.attemptsOf([hash, '0xnone'])).get(hash)).toEqual({
        sender: `0x${'ab'.repeat(20)}`,
        nonce: 12n,
      });
    });
  });

  describe('re-review F1/F3, against a real database', () => {
    it('F1: recording a hash on a record that is no longer live throws (the hook fails, nothing is broadcast)', async () => {
      const tx = await channels.insertTx({
        kind: 'REFUND' as never,
        assetId: ASSET,
        intentId: randomUUID(),
        channelRowIds: [await lane()],
        amount: 1n,
      });
      await channels.finishTx(tx!, 'DROPPED' as never, 'never broadcast');
      await expect(channels.appendTxRef(tx!, '0xlate')).rejects.toThrow(/no longer live/);

      const id = await lane();
      const intent = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
      await dataSource.query(
        `UPDATE voucher_channels SET last_accepted_cumulative = 1000, last_accepted_calls = 1 WHERE id = $1`,
        [id],
      );
      const [voucher] = await dataSource.query(
        `INSERT INTO channel_vouchers (id, channel_row_id, intent_id, cumulative, calls, issued_at, expires_at, signature)
         VALUES ($1, $2, $3, 1000, 1, 1, 100, '0x00') RETURNING id`,
        [randomUUID(), id, intent],
      );
      const settlement = await channels.bindSettlement({
        channelRowId: id,
        voucherId: voucher.id,
        fromSettled: 0n,
        toCumulative: 1000n,
        fromCalls: 0,
        toCalls: 1,
        charge: 1000n,
        waived: 0n,
        trigger: 'AGE',
        intentIds: [intent],
      });
      await channels.markSent(settlement!, null);
      await channels.releaseSettlement(settlement!, 'DROPPED' as never, 'never broadcast');
      await expect(channels.markSent(settlement!, '0xlate')).rejects.toThrow(/no longer live/);
    });

    it('F1: one owner per call — a second caller does not get the refund lock while the first holds it', async () => {
      const intentId = randomUUID();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let inside!: () => void;
      const entered = new Promise<void>((resolve) => (inside = resolve));
      const first = channels.withRefundLock(intentId, async () => {
        inside();
        await held;
        return 'first';
      });
      await entered;
      expect(await channels.withRefundLock(intentId, async () => 'second')).toBeNull();
      expect(await channels.withRefundLock(randomUUID(), async () => 'other call')).toBe(
        'other call',
      );
      release();
      expect(await first).toBe('first');
      expect(await channels.withRefundLock(intentId, async () => 'after')).toBe('after');
    });

    it('F2: the first "dropped" block is kept', async () => {
      const tx = await channels.insertTx({
        kind: 'REFUND' as never,
        assetId: ASSET,
        intentId: randomUUID(),
        channelRowIds: [await lane()],
        amount: 1n,
      });
      expect(await channels.noteDropSeen(tx!, 10n)).toBe(10n);
      expect(await channels.noteDropSeen(tx!, 12n)).toBe(10n);
    });

    it('F3: the channel migrations run over an old schema with rows, and validate outside their transaction', async () => {
      const seeded = await freshMigratedDatabase('assay_channel_seeded_test');
      try {
        for (const name of [
          'ChannelRefundPieces1793404800050',
          'ChannelReplacementCheckValidate1793404800040',
          'ChannelDebtPerCallReplacement1793404800030',
          'DebtGuardHeldReplacement1793404800020',
          'ChannelVoucherIndexes1793404800010',
          'ChannelVouchers1793404800000',
        ]) {
          const [last] = await seeded.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`);
          expect(last.name).toBe(name);
          await seeded.undoLastMigration({ transaction: 'each' });
        }
        expect(
          await seeded.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_intents' AND column_name = 'voucher_format'`,
          ),
        ).toEqual([]);
        await seeded.query(`ALTER TABLE payment_intents DISABLE TRIGGER ALL`);
        const id = randomUUID();
        await seeded.query(
          `INSERT INTO payment_intents (
             id, organization_id, status, agent_id, agent_account, provider_id, provider_account,
             tool_id, rail, call_id, call_class, asset_id, decimals, price_amount, provider_amount,
             platform_fee, request_hash, chain_id, expires_at, voucher_seq, voucher_signature, hold_id)
           VALUES ($1, $2, 'SETTLED', $3, $4, $5, $6, $7, 'RAIL_B_VOUCHER', $8, 'PAID', $9, 6, 1000, 900, 100,
                   $10, $11, now(), 7, $12, $13)`,
          [
            id,
            randomUUID(),
            randomUUID(),
            payer,
            randomUUID(),
            `${CHAIN}:0x${'bb'.repeat(20)}`,
            randomUUID(),
            randomUUID(),
            ASSET,
            `sha256:${'ab'.repeat(32)}`,
            CHAIN,
            `0x${'12'.repeat(65)}`,
            randomUUID(),
          ],
        );
        await seeded.query(`ALTER TABLE payment_intents ENABLE TRIGGER ALL`);
        await seeded.runMigrations({ transaction: 'each' });
        const [row] = await seeded.query(
          `SELECT voucher_format FROM payment_intents WHERE id = $1`,
          [id],
        );
        expect(row.voucher_format).toBe('PER_CALL');
        const checks = await seeded.query(
          `SELECT conname, convalidated FROM pg_constraint
            WHERE conname IN ('chk_payment_intents_voucher_format', 'chk_providers_payout_cadence',
                              'chk_payment_intents_channel_replacement')
            ORDER BY conname`,
        );
        expect(checks).toEqual([
          { conname: 'chk_payment_intents_channel_replacement', convalidated: true },
          { conname: 'chk_payment_intents_voucher_format', convalidated: true },
          { conname: 'chk_providers_payout_cadence', convalidated: true },
        ]);
        // rev3 L-4: re-running the VALIDATE migration over a valid CHECK is a no-op.
        const { ChannelReplacementCheckValidate1793404800040: Validate } =
          await import('@database/postgres/migrations/1793404800040-channel-replacement-check-validate');
        const runner = seeded.createQueryRunner();
        try {
          await new Validate().up(runner);
        } finally {
          await runner.release();
        }
        const indexes = await seeded.query(
          `SELECT indexname FROM pg_indexes
            WHERE indexname IN ('uq_payment_intents_channel_cumulative', 'idx_payment_intents_channel_held',
                                'idx_payment_intents_open_debt')
            ORDER BY indexname`,
        );
        expect(indexes.map((i: { indexname: string }) => i.indexname)).toEqual([
          'idx_payment_intents_channel_held',
          'idx_payment_intents_open_debt',
          'uq_payment_intents_channel_cumulative',
        ]);
      } finally {
        await seeded.destroy();
      }
    }, 300_000);
  });

  it('L-5: the provider settlement summary names the payout address its newest channel pays', async () => {
    const id = await lane(`${CHAIN}:0x${'cd'.repeat(20)}`);
    const [{ provider_id: providerId }] = await dataSource.query(
      `SELECT provider_id FROM voucher_channels WHERE id = $1`,
      [id],
    );
    const summary = await channels.providerChannelSummary(providerId);
    expect(summary.payoutAddress).toBe(`0x${'cd'.repeat(20)}`);
    expect(summary.openChannels).toBe(1);
    expect((await channels.providerChannelSummary(randomUUID())).payoutAddress).toBeNull();
  });

  describe('M-2: a channel debt settled per call in the portal, against a real database', () => {
    const replacement = (seq: string) => ({
      seq,
      signature: `0x${'34'.repeat(65)}`,
      issuedAt: Math.floor(Date.now() / 1000),
      delegate: null,
      expiresAt: new Date(Date.now() + 240_000),
      resource: '/mcp/tools/t',
      resourceHash: 'ab'.repeat(32),
    });
    const admission = () => ({
      scope: {
        payer,
        assetId: ASSET,
        delegate: null,
        escrowSince: new Date(Date.now() - 60_000),
        organizationId: org,
      },
      admit: () => undefined,
    });
    async function voucher(channelRowId: string, cumulative: bigint, expiresAt: number) {
      await dataSource.query(
        `INSERT INTO channel_vouchers (id, channel_row_id, intent_id, cumulative, calls, issued_at, expires_at, signature)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          channelRowId,
          cumulative.toString(),
          Number(cumulative / 1000n),
          expiresAt - 240,
          expiresAt,
          `0x${'11'.repeat(65)}`,
        ],
      );
    }

    it('moves to the per-call door only past the lane deadline; a later renew or settle of the lane never charges it; the refusal lifts once HELD', async () => {
      const id = await lane();
      const now = Math.floor(Date.now() / 1000);
      const debt = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
      const later = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 2000n });
      await dataSource.query(
        `UPDATE voucher_channels SET last_accepted_cumulative = 2000, last_accepted_calls = 2 WHERE id = $1`,
        [id],
      );
      await dataSource.query(
        `UPDATE payment_intents SET expires_at = now() - interval '3 hours' WHERE id = $1`,
        [debt],
      );
      await voucher(id, 1000n, now - 3 * 3600);
      // A later lane voucher still inside its on-chain deadline covers the debt's value too.
      await voucher(id, 2000n, now - 600);
      expect(await channels.lapse(id, [debt], 'ChannelVoucherExpired:Balance')).toBe(1);

      const before = await payments.findOutstandingDebt(payer, debt);
      expect(before?.voucherFormat).toBe('CHANNEL');
      expect(before?.channelVoucherExpiresAt?.getTime()).toBe((now - 600) * 1000);
      expect(
        await payments.replaceChannelDebtPerCall(org, debt, payer, replacement('41'), admission()),
      ).toBe(false);
      // The seq trigger is the backstop for a direct write.
      await expect(
        dataSource.query(
          `UPDATE payment_intents SET voucher_format = 'PER_CALL', replaced_channel_row_id = channel_row_id,
                  replaced_channel_cumulative = channel_cumulative, replaced_channel_calls = channel_calls,
                  channel_replaced_per_call_at = now(), channel_row_id = NULL, channel_cumulative = NULL,
                  channel_calls = NULL, voucher_seq = 41, redemption_replaced_at = now()
            WHERE id = $1`,
          [debt],
        ),
      ).rejects.toThrow(/voucher_seq is immutable/);

      // Past every covering voucher's deadline: moved, REPLACING, still refusing.
      await dataSource.query(
        `UPDATE channel_vouchers SET expires_at = $2::bigint, issued_at = $2::bigint - 240 WHERE channel_row_id = $1`,
        [id, now - 3 * 3600],
      );
      expect(
        await payments.replaceChannelDebtPerCall(org, debt, payer, replacement('41'), admission()),
      ).toBe(true);
      const [moved] = await dataSource.query(
        `SELECT voucher_format, channel_row_id, replaced_channel_row_id, replaced_channel_cumulative::text AS cum,
                voucher_seq::text AS seq, redemption_replaced_at IS NOT NULL AS replaced
           FROM payment_intents WHERE id = $1`,
        [debt],
      );
      expect(moved).toEqual({
        voucher_format: 'PER_CALL',
        channel_row_id: null,
        replaced_channel_row_id: id,
        cum: '1000',
        seq: '41',
        replaced: true,
      });
      const replacing = await payments.findOutstandingDebt(payer, debt);
      expect(replacing?.voucherFormat).toBe('PER_CALL');
      expect(replacing?.replacedAt).not.toBeNull();
      expect(replacing?.replacedChannel).toBe(true);
      // Once only: not a second move, and the lane position can never come back.
      expect(
        await payments.replaceChannelDebtPerCall(org, debt, payer, replacement('42'), admission()),
      ).toBe(false);
      await expect(
        dataSource.query(`UPDATE payment_intents SET voucher_format = 'CHANNEL' WHERE id = $1`, [
          debt,
        ]),
      ).rejects.toThrow(/immutable/);
      await expect(
        dataSource.query(
          `UPDATE payment_intents SET replaced_channel_cumulative = 5 WHERE id = $1`,
          [debt],
        ),
      ).rejects.toThrow(/immutable/);

      // (1) A renew finds nothing of it on the lane.
      expect(await channels.replacedPerCall(debt)).toBe(true);
      expect(await channels.replacedPerCall(later)).toBe(false);
      expect((await channels.lapsedDebtsUpTo(id, 5000n)).map((d) => d.intentId)).not.toContain(
        debt,
      );
      await channels.markReplaced(id, 5000n);
      expect((await channels.calls(id)).map((c) => c.intentId)).toEqual([later]);

      // (2) A later settle of the lane across its cumulative charges only the
      // other call; the debt's step is waived.
      const { ChannelSettlementService } =
        await import('@modules/payment/services/channel-settlement.service');
      const { DEFAULT_CHANNEL_POLICY } =
        await import('@modules/payment/domain/channel/channel-policy');
      const { EMPTY_SLOT } = await import('@modules/payment/domain/channel/channel-voucher');
      const [{ channel_key: key }] = await dataSource.query(
        `SELECT channel_key FROM voucher_channels WHERE id = $1`,
        [id],
      );
      await dataSource.query(
        `UPDATE payment_intents SET created_at = now() - interval '40 minutes' WHERE id = $1`,
        [later],
      );
      await voucher(id, 2000n, now + 200);
      const items: Array<{ charge: bigint; cumulative: bigint }> = [];
      const outcome = (item: any, index: number) => ({
        kind: 'SETTLED',
        index,
        key,
        cumulative: item.voucher.cumulative,
        calls: item.voucher.calls,
        charge: item.charge,
        maturityHour: Math.ceil((now + 3_600) / 3_600),
        takeRateBps: 1_000,
        opened: null,
        deferred: null,
      });
      const door = {
        doorLive: async () => true,
        chainNow: async () => now,
        collectHoldSeconds: async () => 3_600,
        takeRateBps: async () => 1_000,
        treasury: async () => `0x${'ee'.repeat(20)}`,
        isFrozen: async () => false,
        readBooks: async () => ({ slot: { ...EMPTY_SLOT }, unpaid: 0n, totalUnpaid: 0n, held: 0n }),
        signerWindow: async () => ({
          validUntil: null,
          revoked: false,
          revokeGraceEndsAt: null,
          heldCapsEndAt: null,
        }),
        providerRisk: async () => ({
          unbonding: false,
          slashPending: false,
          nearFloor: false,
          blocked: false,
        }),
        txReceipt: async () => ({ state: 'UNKNOWN' }),
        confirmedNonce: async () => 0n,
        simulateSettle: async (_a: unknown, list: any[]) => list.map(outcome),
        settle: async (_a: unknown, list: any[], _lane: string, opts: any) => {
          for (const item of list)
            items.push({ charge: item.charge, cumulative: item.voucher.cumulative });
          const hash = `0x${randomUUID().replace(/-/g, '')}`;
          await opts.beforeBroadcast(hash, { from: `0x${'90'.repeat(20)}`, nonce: 4n });
          return { txRef: hash, landedAt: now, outcomes: list.map(outcome) };
        },
      };
      const service = new ChannelSettlementService(
        channels,
        {
          resolve: async () => undefined,
          findById: async () => null,
          releaseHold: async () => true,
          bookHeldCollected: async () => undefined,
          bookBlockedProviderRefund: async () => ({ booked: false, disputeIds: [] }),
        } as never,
        door as never,
        { emit: async () => undefined } as never,
        new Set([CHAIN]),
        DEFAULT_CHANNEL_POLICY,
        null,
        () => Date.now(),
      );
      (service as any).logger = {
        error: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        log: () => undefined,
      };
      await service.run(ASSET as never);
      expect(items).toEqual([{ charge: 1000n, cumulative: 2000n }]);
      const [settlement] = await dataSource.query(
        `SELECT charge::text AS charge, waived::text AS waived, charged_intent_ids FROM channel_settlements
          WHERE channel_row_id = $1 AND status = 'LANDED'`,
        [id],
      );
      expect(settlement).toEqual({ charge: '1000', waived: '1000', charged_intent_ids: [later] });
      const [debtRow] = await dataSource.query(
        `SELECT held_status, channel_settlement_id FROM payment_intents WHERE id = $1`,
        [debt],
      );
      expect(debtRow).toEqual({ held_status: null, channel_settlement_id: null });

      // The per-call redemption lands it: the refusal lifts (relaxed H-1).
      expect(await payments.markHeld(org, debt, new Date(), new Date(Date.now() + 3_600_000))).toBe(
        true,
      );
      expect(await payments.findOutstandingDebt(payer, debt)).toBeNull();
    });

    it('refuses the move while a settlement charges the call, and for a debt not lapsed', async () => {
      const id = await lane();
      const now = Math.floor(Date.now() / 1000);
      const debt = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
      await dataSource.query(
        `UPDATE payment_intents SET expires_at = now() - interval '3 hours' WHERE id = $1`,
        [debt],
      );
      await voucher(id, 1000n, now - 3 * 3600);
      // Not lapsed: not a debt.
      expect(
        await payments.replaceChannelDebtPerCall(org, debt, payer, replacement('51'), admission()),
      ).toBe(false);
      const [{ id: voucherId }] = await dataSource.query(
        `SELECT id FROM channel_vouchers WHERE channel_row_id = $1`,
        [id],
      );
      const settlement = await channels.bindSettlement({
        channelRowId: id,
        voucherId,
        fromSettled: 0n,
        toCumulative: 1000n,
        fromCalls: 0,
        toCalls: 1,
        charge: 1000n,
        waived: 0n,
        trigger: 'AGE',
        intentIds: [debt],
        chargedIntentIds: [debt],
      });
      expect(settlement).not.toBeNull();
      await dataSource.query(
        `UPDATE payment_intents SET redemption_lapsed_at = now(), redemption_last_error = 'x' WHERE id = $1`,
        [debt],
      );
      expect(
        await payments.replaceChannelDebtPerCall(org, debt, payer, replacement('51'), admission()),
      ).toBe(false);
      await channels.releaseSettlement(settlement!, 'DROPPED' as never, 'test');
      expect(
        await payments.replaceChannelDebtPerCall(org, debt, payer, replacement('51'), admission()),
      ).toBe(true);
    });

    /** A lapsed CHANNEL debt at 1000 on a fresh lane, every covering voucher past its deadline. */
    async function lapsedChannelDebt(): Promise<{ id: string; debt: string; now: number }> {
      const id = await lane();
      const now = Math.floor(Date.now() / 1000);
      const debt = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
      await dataSource.query(
        `UPDATE payment_intents SET expires_at = now() - interval '3 hours' WHERE id = $1`,
        [debt],
      );
      await dataSource.query(
        `UPDATE voucher_channels SET last_accepted_cumulative = 1000, last_accepted_calls = 1 WHERE id = $1`,
        [id],
      );
      await voucher(id, 1000n, now - 3 * 3600);
      expect(await channels.lapse(id, [debt], 'ChannelVoucherExpired:Balance')).toBe(1);
      return { id, debt, now };
    }

    it('rev3 L-2: the debt read carries the lane key and DB settled; the move holds to the chain-checked settled value', async () => {
      const { id, debt } = await lapsedChannelDebt();
      const read = await payments.findOutstandingDebt(payer, debt);
      const [{ channel_key: key }] = await dataSource.query(
        `SELECT channel_key FROM voucher_channels WHERE id = $1`,
        [id],
      );
      expect(read?.channelKey).toBe(key);
      expect(read?.channelSettledCumulative).toBe('0');
      // The lane moved since the chain was read: refused, retryable, nothing changed.
      expect(
        await payments.replaceChannelDebtPerCall(
          org,
          debt,
          payer,
          replacement('61'),
          admission(),
          null,
          '500',
        ),
      ).toBe('LANE_MOVED');
      await dataSource.query(`UPDATE voucher_channels SET settling_to = 1000 WHERE id = $1`, [id]);
      expect(
        await payments.replaceChannelDebtPerCall(
          org,
          debt,
          payer,
          replacement('61'),
          admission(),
          null,
          '0',
        ),
      ).toBe('LANE_MOVED');
      const [unchanged] = await dataSource.query(
        `SELECT voucher_format, channel_row_id FROM payment_intents WHERE id = $1`,
        [debt],
      );
      expect(unchanged).toEqual({ voucher_format: 'CHANNEL', channel_row_id: id });
      await dataSource.query(`UPDATE voucher_channels SET settling_to = NULL WHERE id = $1`, [id]);
      expect(
        await payments.replaceChannelDebtPerCall(
          org,
          debt,
          payer,
          replacement('61'),
          admission(),
          null,
          '0',
        ),
      ).toBe(true);
    });

    it('rev3 L-2: bindSettlement never binds a moved call, and rolls its settling_to back', async () => {
      const { id, debt } = await lapsedChannelDebt();
      const [{ id: voucherId }] = await dataSource.query(
        `SELECT id FROM channel_vouchers WHERE channel_row_id = $1`,
        [id],
      );
      expect(
        await payments.replaceChannelDebtPerCall(org, debt, payer, replacement('62'), admission()),
      ).toBe(true);
      const bind = () =>
        channels.bindSettlement({
          channelRowId: id,
          voucherId,
          fromSettled: 0n,
          toCumulative: 1000n,
          fromCalls: 0,
          toCalls: 1,
          charge: 1000n,
          waived: 0n,
          trigger: 'RECOVER',
          intentIds: [debt],
          chargedIntentIds: [debt],
        });
      expect(await bind()).toBeNull();
      const [laneRow] = await dataSource.query(
        `SELECT settling_to FROM voucher_channels WHERE id = $1`,
        [id],
      );
      expect(laneRow.settling_to).toBeNull();
      expect(
        await dataSource.query(`SELECT 1 FROM channel_settlements WHERE channel_row_id = $1`, [id]),
      ).toEqual([]);
      // Waiving it (not charged) still binds.
      expect(
        await channels.bindSettlement({
          channelRowId: id,
          voucherId,
          fromSettled: 0n,
          toCumulative: 1000n,
          fromCalls: 0,
          toCalls: 1,
          charge: 0n,
          waived: 1000n,
          trigger: 'AGE',
          intentIds: [],
          chargedIntentIds: [],
        }),
      ).not.toBeNull();
    });

    it('rev3 L-2: a move waiting on a settlement bound under the lane lock sees it and refuses', async () => {
      const { id, debt } = await lapsedChannelDebt();
      const [{ id: voucherId }] = await dataSource.query(
        `SELECT id FROM channel_vouchers WHERE channel_row_id = $1`,
        [id],
      );
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await runner.startTransaction();
        // What bindSettlement does, held open: the lane row locked, a settlement charging the call.
        await runner.query(`UPDATE voucher_channels SET settling_to = 1000 WHERE id = $1`, [id]);
        await runner.query(
          `INSERT INTO channel_settlements (id, channel_row_id, voucher_id, from_settled, to_cumulative,
             from_calls, to_calls, charge, waived, status, trigger, charged_intent_ids)
           VALUES ($1, $2, $3, 0, 1000, 0, 1, 1000, 0, 'PENDING', 'AGE', ARRAY[$4]::uuid[])`,
          [randomUUID(), id, voucherId, debt],
        );
        const move = payments.replaceChannelDebtPerCall(
          org,
          debt,
          payer,
          replacement('63'),
          admission(),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await runner.commitTransaction();
        expect(await move).toBe(false);
      } finally {
        await runner.release();
      }
      const [row] = await dataSource.query(
        `SELECT voucher_format FROM payment_intents WHERE id = $1`,
        [debt],
      );
      expect(row.voucher_format).toBe('CHANNEL');
    });

    it('rev3 L-1: a scheduler pass does not lapse a call while the chain settled the lane past the DB unbooked', async () => {
      const id = await lane();
      const now = Math.floor(Date.now() / 1000);
      const call = await seed({ format: 'CHANNEL', channelRowId: id, cumulative: 1000n });
      await dataSource.query(
        `UPDATE voucher_channels SET last_accepted_cumulative = 1000, last_accepted_calls = 1,
                last_skip_reason = 'Balance' WHERE id = $1`,
        [id],
      );
      await voucher(id, 1000n, now - 3 * 3600);
      const { ChannelSettlementService } =
        await import('@modules/payment/services/channel-settlement.service');
      const { DEFAULT_CHANNEL_POLICY } =
        await import('@modules/payment/domain/channel/channel-policy');
      const { EMPTY_SLOT } = await import('@modules/payment/domain/channel/channel-voucher');
      let chainSettled = 500n;
      const alerts: string[] = [];
      const door = {
        doorLive: async () => true,
        chainNow: async () => now,
        collectHoldSeconds: async () => 3_600,
        takeRateBps: async () => 1_000,
        treasury: async () => `0x${'ee'.repeat(20)}`,
        isFrozen: async () => false,
        readBooks: async () => ({
          slot: { ...EMPTY_SLOT, settled: chainSettled },
          unpaid: 0n,
          totalUnpaid: 0n,
          held: 0n,
        }),
        signerWindow: async () => ({
          validUntil: null,
          revoked: false,
          revokeGraceEndsAt: null,
          heldCapsEndAt: null,
        }),
        providerRisk: async () => ({
          unbonding: false,
          slashPending: false,
          nearFloor: false,
          blocked: false,
        }),
        txReceipt: async () => ({ state: 'UNKNOWN' }),
        confirmedNonce: async () => 0n,
        simulateSettle: async () => [],
        settle: async () => {
          throw new Error('no settle expected');
        },
      };
      const service = new ChannelSettlementService(
        channels,
        {
          resolve: async () => undefined,
          findById: async () => null,
          releaseHold: async () => true,
          bookHeldCollected: async () => undefined,
          bookBlockedProviderRefund: async () => ({ booked: false, disputeIds: [] }),
        } as never,
        door as never,
        { emit: async (alert: { name: string }) => void alerts.push(alert.name) } as never,
        new Set([CHAIN]),
        DEFAULT_CHANNEL_POLICY,
        null,
        () => Date.now(),
      );
      (service as any).logger = {
        error: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        log: () => undefined,
      };
      const lapsed = async () =>
        (
          await dataSource.query(
            `SELECT redemption_lapsed_at IS NOT NULL AS lapsed FROM payment_intents WHERE id = $1`,
            [call],
          )
        )[0].lapsed;
      await service.run(ASSET as never);
      expect(alerts).toContain('channel_chain_ahead_unknown');
      expect(await lapsed()).toBe(false);
      // The chain agrees with the DB again: the buyer lapse goes ahead.
      chainSettled = 0n;
      await service.run(ASSET as never);
      expect(await lapsed()).toBe(true);
    });
  });
});
