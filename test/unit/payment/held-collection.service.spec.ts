import { randomUUID } from 'node:crypto';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  PaymentIntentRepository,
  RedemptionExclusions,
} from '@database/postgres/repositories/payment-intent.repository';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import { ChainStateGatePort } from '@modules/chains/ports/chain-state-gate.port';
import {
  HELD_TIMEOUT_SECONDS,
  HeldKey,
  HeldStatus,
  MAX_HELD_BATCH,
} from '@modules/payment/ports/held-payments.port';
import { PaymentRail } from '@modules/payment/ports/payment.types';
import {
  BLOCKED_HELD_UNREFUNDED_ALERT,
  HeldCollectionService,
} from '@modules/payment/services/held-collection.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { Alert } from '@shared/alerting';

import { FakeHeldPayments } from '../../integration/helpers/fake-held-payments';
import { addBlock, blocklistOf } from '../helpers/blocklist';

/**
 * The held-payment collector's two owner rules (2026-10-18):
 *
 * 1. A blocked provider's payments still held are refunded at once
 *    (`refundHeldBatch`, chunked, idempotent), never collected, and paged when
 *    one is still unrefunded within 24 h of the chain's timeout.
 * 2. Past the timeout (anyone may collect) a record is collected singly, never
 *    in a batch; a single collect that fails because the record is no longer
 *    held is reconciled from `held()`, not retried.
 */

const ASSET = ASSET_IDS.USDG_ROBINHOOD_TESTNET as AssetId;
const CHAIN = chainIdOf(ASSET);
const HOUR = 3_600_000;
const TIMEOUT_MS = HELD_TIMEOUT_SECONDS * 1000;

interface Repo {
  collectable: PaymentIntentEntity[];
  pastTimeout: PaymentIntentEntity[];
  blockedHeld: PaymentIntentEntity[];
  nearTimeout: PaymentIntentEntity[];
  failures: Array<{ id: string; error: string }>;
  blockedQueries: RedemptionExclusions[];
}

function setup(options: { chainBlocked?: string[] } = {}) {
  const repo: Repo = {
    collectable: [],
    pastTimeout: [],
    blockedHeld: [],
    nearTimeout: [],
    failures: [],
    blockedQueries: [],
  };
  const payments = {
    findCollectable: jest.fn(async (rail: string) =>
      repo.collectable.filter((row) => row.rail === rail),
    ),
    findHeldPastTimeout: jest.fn(async () => repo.pastTimeout),
    findHeldOfBlockedProviders: jest.fn(async (_rail: string, exclude: RedemptionExclusions) => {
      repo.blockedQueries.push(exclude);
      return repo.blockedHeld;
    }),
    findBlockedHeldNearTimeout: jest.fn(async () => repo.nearTimeout),
    findHeldAssetIds: jest.fn(async () => [ASSET]),
    recordHeldFailure: jest.fn(async (_org: string, id: string, error: string) => {
      repo.failures.push({ id, error });
    }),
  } as unknown as PaymentIntentRepository;
  const intents = {
    bookHeldCollected: jest.fn(async () => undefined),
    refundHeldForDispute: jest.fn(async () => 'REFUNDED'),
    bookBlockedProviderRefund: jest.fn(async () => true),
  };
  const alerts: Alert[] = [];
  const held = new FakeHeldPayments();
  const blocklist: AccountBlocklistService = blocklistOf();
  const chainState = {
    blockedAccounts: async () => options.chainBlocked ?? [],
  } as unknown as ChainStateGatePort;
  const service = new HeldCollectionService(
    payments,
    intents as unknown as PaymentIntentService,
    blocklist,
    { emit: async (alert: Alert) => void alerts.push(alert) },
    held,
    chainState,
  );
  return { service, repo, payments, intents, alerts, held, blocklist };
}

let seq = 0;

function heldRow(
  held: FakeHeldPayments,
  options: {
    collectableAgoMs?: number;
    providerId?: string;
    providerAccount?: string;
    disputeOutcome?: string | null;
  } = {},
): PaymentIntentEntity {
  seq += 1;
  const collectableAt = new Date(Date.now() - (options.collectableAgoMs ?? 2 * HOUR));
  const row = {
    id: randomUUID(),
    organizationId: randomUUID(),
    rail: PaymentRail.RAIL_B_VOUCHER,
    assetId: ASSET,
    agentAccount: `${CHAIN}:0x${seq.toString(16).padStart(40, 'a')}`,
    providerId: options.providerId ?? randomUUID(),
    providerAccount: options.providerAccount ?? `${CHAIN}:0x${'b'.repeat(40)}`,
    voucherSeq: String(seq),
    collectableAt,
    disputeOutcome: options.disputeOutcome ?? null,
    heldStatus: 'HELD',
    heldLastError: null,
  } as unknown as PaymentIntentEntity;
  held.redeemInto(ASSET, keyOf(row), 1_000_000n, collectableAt);
  return row;
}

function keyOf(row: PaymentIntentEntity): HeldKey {
  return { payer: row.agentAccount as AccountId, seq: row.voucherSeq as string };
}

async function statusOf(held: FakeHeldPayments, row: PaymentIntentEntity) {
  return (await held.readHeld(ASSET, keyOf(row)))?.status;
}

describe('HeldCollectionService — a blocked provider', () => {
  it('refunds its held payments in one batch, books the forfeit, and never collects them', async () => {
    const { service, repo, intents, held, blocklist } = setup();
    const provider = randomUUID();
    const rows = [1, 2, 3].map(() => heldRow(held, { providerId: provider }));
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.blockedHeld = rows;
    // Even if a query handed them to the collector, it must not collect them.
    repo.collectable = rows;
    repo.pastTimeout = [];

    expect(await service.run()).toBe(0);

    expect(held.sent).toEqual([{ op: 'refund', keys: rows.map(keyOf) }]);
    for (const row of rows) expect(await statusOf(held, row)).toBe(HeldStatus.REFUNDED);
    expect(intents.bookBlockedProviderRefund).toHaveBeenCalledTimes(3);
    expect(intents.bookBlockedProviderRefund).toHaveBeenCalledWith(
      rows[0].organizationId,
      rows[0].id,
      'ProviderBlocked',
      expect.stringMatching(/^0x/),
    );
    expect(intents.bookHeldCollected).not.toHaveBeenCalled();
    expect(repo.blockedQueries[0].organizationIds).toContain(provider);
  });

  it('chunks the refund into batches of MAX_HELD_BATCH', async () => {
    const { service, repo, held, blocklist } = setup();
    const provider = randomUUID();
    repo.blockedHeld = Array.from({ length: MAX_HELD_BATCH + 6 }, () =>
      heldRow(held, { providerId: provider }),
    );
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });

    await service.run();

    expect(held.sent.map((s) => [s.op, s.keys.length])).toEqual([
      ['refund', MAX_HELD_BATCH],
      ['refund', 6],
    ]);
  });

  it('a blocked payout wallet, and a payout address on the chain blocklist, count too', async () => {
    const onChain = `${CHAIN}:0x${'c'.repeat(40)}`;
    const { service, repo, intents, held, blocklist } = setup({ chainBlocked: [onChain] });
    const wallet = `${CHAIN}:0x${'d'.repeat(40)}`;
    addBlock(blocklist, { kind: BlockSubjectKind.WALLET, subject: wallet });
    const byWallet = heldRow(held, { providerAccount: wallet });
    const byChain = heldRow(held, { providerAccount: onChain });
    repo.blockedHeld = [byWallet, byChain];

    await service.run();

    expect(repo.blockedQueries[0].chainAccounts).toEqual([onChain.toLowerCase()]);
    const causes = intents.bookBlockedProviderRefund.mock.calls.map(
      (call) => (call as unknown[])[2],
    );
    expect(causes).toEqual(['PayeeBlocked', 'PayeeBlockedOnChain']);
  });

  it('is idempotent: a record already refunded is booked without a send', async () => {
    const { service, repo, intents, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    await held.refund(ASSET, [keyOf(row)]);
    held.sent.length = 0;
    repo.blockedHeld = [row];

    await service.run();

    expect(held.sent).toEqual([]);
    expect(intents.bookBlockedProviderRefund).toHaveBeenCalledWith(
      row.organizationId,
      row.id,
      'ProviderBlocked',
      null,
    );
  });

  it('a refused batch is refunded singly; a single that fails backs off', async () => {
    const { service, repo, held, blocklist } = setup();
    const provider = randomUUID();
    const rows = [1, 2].map(() => heldRow(held, { providerId: provider }));
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.blockedHeld = rows;
    const refund = held.refund.bind(held);
    let calls = 0;
    jest.spyOn(held, 'refund').mockImplementation(async (asset, keys) => {
      calls += 1;
      if (keys.length > 1 || calls === 2) throw new Error('refundHeld reverted');
      return refund(asset, keys);
    });

    await service.run();

    expect(await statusOf(held, rows[0])).toBe(HeldStatus.HELD);
    expect(await statusOf(held, rows[1])).toBe(HeldStatus.REFUNDED);
    expect(repo.failures.map((f) => f.id)).toEqual([rows[0].id]);
  });

  it('past the timeout: not refunded (closed), not collected — booked if someone collects', async () => {
    const { service, repo, intents, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider, collectableAgoMs: TIMEOUT_MS + HOUR });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.pastTimeout = [row];

    await service.run();
    expect(held.sent).toEqual([]);
    expect(intents.bookHeldCollected).not.toHaveBeenCalled();

    held.collectAsAnyone(keyOf(row));
    await service.run();
    expect(held.sent).toEqual([]);
    expect(intents.bookHeldCollected).toHaveBeenCalledWith(row.organizationId, row.id, null);
  });

  it('pages a held payment still unrefunded within 24 h of the timeout', async () => {
    const { service, repo, alerts, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider, collectableAgoMs: TIMEOUT_MS - 2 * HOUR });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.nearTimeout = [row];

    await service.run();

    expect(alerts).toEqual([
      expect.objectContaining({
        name: BLOCKED_HELD_UNREFUNDED_ALERT,
        severity: 'CRITICAL',
        dedupeKey: row.id,
        details: expect.objectContaining({ intentId: row.id, cause: 'ProviderBlocked' }),
      }),
    ]);
    expect(alerts[0].summary).toMatch(/less than 24 h away/);
  });
});

describe('HeldCollectionService — past the timeout, one by one', () => {
  it('collects records past the timeout singly, never in a batch', async () => {
    const { service, repo, intents, held } = setup();
    const rows = [1, 2, 3].map(() => heldRow(held, { collectableAgoMs: TIMEOUT_MS + HOUR }));
    // The collectable queue returns them too: they must not be batched there.
    repo.collectable = rows;
    repo.pastTimeout = rows;

    expect(await service.run()).toBe(3);

    expect(held.sent.map((s) => [s.op, s.keys.length])).toEqual([
      ['collect', 1],
      ['collect', 1],
      ['collect', 1],
    ]);
    expect(intents.bookHeldCollected).toHaveBeenCalledTimes(3);
  });

  it('batches the rest and sends a record about to time out singly', async () => {
    const { service, repo, held } = setup();
    const fresh = [1, 2].map(() => heldRow(held));
    const late = heldRow(held, { collectableAgoMs: TIMEOUT_MS - 60_000 });
    repo.collectable = [...fresh, late];
    repo.pastTimeout = [late];

    expect(await service.run()).toBe(3);

    expect(held.sent.map((s) => s.keys.map((k) => k.seq))).toEqual([
      fresh.map((row) => row.voucherSeq),
      [late.voucherSeq],
    ]);
  });

  it('a single collect a stranger beat is read back and booked, not retried', async () => {
    const { service, repo, intents, held } = setup();
    const row = heldRow(held, { collectableAgoMs: TIMEOUT_MS + HOUR });
    repo.pastTimeout = [row];
    jest.spyOn(held, 'collect').mockImplementation(async (_asset, keys) => {
      held.collectAsAnyone(keys[0]);
      throw new Error('execution reverted: HeldNotHeld');
    });

    expect(await service.run()).toBe(1);

    expect(intents.bookHeldCollected).toHaveBeenCalledWith(row.organizationId, row.id, null);
    expect(repo.failures).toEqual([]);
  });

  it('a single collect that fails while the record is still held backs off', async () => {
    const { service, repo, intents, held } = setup();
    const row = heldRow(held, { collectableAgoMs: TIMEOUT_MS + HOUR });
    repo.pastTimeout = [row];
    held.stick(keyOf(row));

    expect(await service.run()).toBe(0);

    expect(intents.bookHeldCollected).not.toHaveBeenCalled();
    expect(repo.failures.map((f) => f.id)).toEqual([row.id]);
  });

  it('a disputed record past the timeout is still only synced and paged', async () => {
    const { service, repo, alerts, held } = setup();
    const row = heldRow(held, { collectableAgoMs: TIMEOUT_MS + HOUR, disputeOutcome: 'OPEN' });
    repo.pastTimeout = [row];

    await service.run();

    expect(held.sent).toEqual([]);
    expect(alerts.map((a) => a.name)).toEqual(['held_payment_past_timeout']);
  });
});
