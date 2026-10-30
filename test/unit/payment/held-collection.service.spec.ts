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
  GatheringPolicy,
  NO_GATHERING,
} from '@modules/payment/constants/settlement-gathering.constants';
import {
  BLOCKED_HELD_UNREFUNDED_ALERT,
  HeldCollectionService,
} from '@modules/payment/services/held-collection.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import {
  NotificationEvent,
  NotificationRequest,
} from '@modules/notification/ports/notification.port';
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
  /** `findTimedOutCollectable`: past the timeout, to collect singly. */
  timedOut: PaymentIntentEntity[];
  /** `findHeldPastTimeout`: past the timeout, synced only. */
  toSync: PaymentIntentEntity[];
  blockedHeld: PaymentIntentEntity[];
  blockedRailA: PaymentIntentEntity[];
  nearTimeout: PaymentIntentEntity[];
  failures: Array<{ id: string; error: string }>;
  causes: Array<{ id: string; cause: string }>;
  cleared: string[];
  blockedQueries: RedemptionExclusions[];
  /** Runs when the blocked-provider query is read (a block changing mid-pass). */
  onBlockedQuery?: () => void;
  onCollectableQuery?: () => void;
  /** Makes `summarizeCollectable` throw (the gathering check fails). */
  summaryThrows?: boolean;
}

function setup(options: { chainBlocked?: string[]; gathering?: GatheringPolicy } = {}) {
  const repo: Repo = {
    collectable: [],
    timedOut: [],
    toSync: [],
    blockedHeld: [],
    blockedRailA: [],
    nearTimeout: [],
    failures: [],
    causes: [],
    cleared: [],
    blockedQueries: [],
  };
  const payments = {
    findCollectable: jest.fn(
      async (rail: string, _limit: number, _exclude: unknown, before: number | null = null) => {
        repo.onCollectableQuery?.();
        return repo.collectable.filter(
          (row) =>
            row.rail === rail &&
            (before === null || (row.collectableAt as Date).getTime() + before * 1000 > Date.now()),
        );
      },
    ),
    // What the batched collect would take, per asset — as the SQL counts it.
    summarizeCollectable: jest.fn(async (rail: string, before: number) => {
      if (repo.summaryThrows) throw new Error('database unavailable');
      const summary = new Map<string, { count: number; oldestCollectableAt: Date | null }>();
      for (const row of repo.collectable) {
        const at = row.collectableAt as Date;
        if (row.rail !== rail || at.getTime() + before * 1000 <= Date.now()) continue;
        const entry = summary.get(row.assetId) ?? { count: 0, oldestCollectableAt: null };
        summary.set(row.assetId, {
          count: entry.count + 1,
          oldestCollectableAt:
            entry.oldestCollectableAt && entry.oldestCollectableAt <= at
              ? entry.oldestCollectableAt
              : at,
        });
      }
      return summary;
    }),
    findTimedOutCollectable: jest.fn(async () => repo.timedOut),
    findHeldPastTimeout: jest.fn(async () => repo.toSync),
    findHeldOfBlockedProviders: jest.fn(async (rail: string, exclude: RedemptionExclusions) => {
      if (rail === PaymentRail.RAIL_A_PER_CALL) return repo.blockedRailA;
      repo.blockedQueries.push(exclude);
      repo.onBlockedQuery?.();
      return repo.blockedHeld;
    }),
    recordHeldRefundCause: jest.fn(async (_org: string, id: string, cause: string) => {
      repo.causes.push({ id, cause });
    }),
    clearHeldRefundCause: jest.fn(async (_org: string, id: string) => {
      repo.cleared.push(id);
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
    bookBlockedProviderRefund: jest.fn(async () => ({
      booked: true,
      disputeIds: [] as string[],
    })),
  };
  const alerts: Alert[] = [];
  const notified: NotificationRequest[] = [];
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
    { notify: async (request: NotificationRequest) => void notified.push(request) } as never,
    options.gathering,
  );
  return { service, repo, payments, intents, alerts, held, blocklist, notified };
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
    heldRetryAt: null,
    redemptionLastError: null,
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
    repo.toSync = [row];

    await service.run();
    expect(held.sent).toEqual([]);
    // Still held: backed off, so it does not head the queue every minute.
    expect(repo.failures.map((f) => f.id)).toEqual([row.id]);
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
        dedupeKey: `${row.id}:near`,
        suppressionWindowSeconds: 86_400,
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
    repo.timedOut = rows;

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
    repo.timedOut = [late];

    expect(await service.run()).toBe(3);

    expect(held.sent.map((s) => s.keys.map((k) => k.seq))).toEqual([
      fresh.map((row) => row.voucherSeq),
      [late.voucherSeq],
    ]);
  });

  it('a single collect a stranger beat is read back and booked, not retried', async () => {
    const { service, repo, intents, held } = setup();
    const row = heldRow(held, { collectableAgoMs: TIMEOUT_MS + HOUR });
    repo.timedOut = [row];
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
    repo.timedOut = [row];
    held.stick(keyOf(row));

    expect(await service.run()).toBe(0);

    expect(intents.bookHeldCollected).not.toHaveBeenCalled();
    expect(repo.failures.map((f) => f.id)).toEqual([row.id]);
  });

  it('a disputed record past the timeout is still only synced and paged', async () => {
    const { service, repo, alerts, held } = setup();
    const row = heldRow(held, { collectableAgoMs: TIMEOUT_MS + HOUR, disputeOutcome: 'OPEN' });
    repo.toSync = [row];

    await service.run();

    expect(held.sent).toEqual([]);
    expect(alerts.map((a) => a.name)).toEqual(['held_payment_past_timeout']);
    expect(repo.failures.map((f) => f.id)).toEqual([row.id]);
  });
});

describe('HeldCollectionService — review fixes', () => {
  const unblock = (blocklist: AccountBlocklistService, provider: string) =>
    blocklist.applied({
      kind: 'unblocked',
      subjectKind: BlockSubjectKind.ORGANIZATION,
      subjectKey: provider,
    });

  it('a block lifted after the refund was sent: still booked, under the recorded cause', async () => {
    const { service, repo, intents, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.blockedHeld = [row];
    const refund = held.refund.bind(held);
    jest.spyOn(held, 'refund').mockImplementation(async (asset, keys) => {
      const result = await refund(asset, keys);
      await unblock(blocklist, provider);
      return result;
    });

    await service.run();

    expect(repo.causes).toEqual([{ id: row.id, cause: 'ProviderBlocked' }]);
    expect(intents.bookBlockedProviderRefund).toHaveBeenCalledWith(
      row.organizationId,
      row.id,
      'ProviderBlocked',
      expect.stringMatching(/^0x/),
    );
  });

  it('a chain REFUNDED nothing explains any more is booked as a forfeit, not left looping', async () => {
    const { service, repo, intents, held } = setup();
    const row = heldRow(held);
    await held.refund(ASSET, [keyOf(row)]);
    repo.collectable = [row];

    await service.run();

    expect(intents.bookBlockedProviderRefund).toHaveBeenCalledWith(
      row.organizationId,
      row.id,
      'RefundedByRedeemer',
      null,
    );
  });

  it('…and under the cause recorded on the row when there is one', async () => {
    const { service, repo, intents, held } = setup();
    const row = heldRow(held);
    (row as { redemptionLastError: string | null }).redemptionLastError = 'PayeeBlocked';
    await held.refund(ASSET, [keyOf(row)]);
    repo.collectable = [row];

    await service.run();

    expect(intents.bookBlockedProviderRefund).toHaveBeenCalledWith(
      row.organizationId,
      row.id,
      'PayeeBlocked',
      null,
    );
  });

  it('a block lifted before the send: no refund goes out', async () => {
    const { service, repo, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.blockedHeld = [row];
    repo.onBlockedQuery = () => void unblock(blocklist, provider);

    await service.run();

    expect(held.sent).toEqual([]);
    expect(await statusOf(held, row)).toBe(HeldStatus.HELD);
  });

  it('a block added mid-pass: no collect goes out for it', async () => {
    const { service, repo, intents, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider });
    repo.collectable = [row];
    repo.onCollectableQuery = () =>
      addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });

    await service.run();

    expect(held.sent).toEqual([]);
    expect(intents.bookHeldCollected).not.toHaveBeenCalled();
  });

  it('rail A: a blocked provider’s withheld credit is released, never credited', async () => {
    const { service, repo, intents, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider });
    (row as { rail: string }).rail = PaymentRail.RAIL_A_PER_CALL;
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.blockedRailA = [row];
    repo.collectable = [row];

    await service.run();

    expect(intents.bookBlockedProviderRefund).toHaveBeenCalledWith(
      row.organizationId,
      row.id,
      'ProviderBlocked',
      null,
    );
    expect(intents.bookHeldCollected).not.toHaveBeenCalled();
    expect(held.sent).toEqual([]);
  });

  it('does not page a payment refunded this pass while held() still lags', async () => {
    const { service, repo, alerts, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider, collectableAgoMs: TIMEOUT_MS - 2 * HOUR });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.blockedHeld = [row];
    repo.nearTimeout = [row];
    const read = held.readHeld.bind(held);
    jest.spyOn(held, 'readHeld').mockImplementation(async (asset, key) => {
      const record = await read(asset, key);
      // A lagging node: the refund landed, the read still says HELD.
      return record && { ...record, status: HeldStatus.HELD };
    });

    await service.run();

    expect(held.sent.map((s) => s.op)).toEqual(['refund']);
    expect(alerts).toEqual([]);
  });

  it('does not page a payment held() shows as moved: books it instead', async () => {
    const { service, repo, intents, alerts, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider, collectableAgoMs: TIMEOUT_MS + HOUR });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    held.collectAsAnyone(keyOf(row));
    repo.nearTimeout = [row];

    await service.run();

    expect(alerts).toEqual([]);
    expect(intents.bookHeldCollected).toHaveBeenCalledWith(row.organizationId, row.id, null);
  });

  it('pages past the timeout under its own key', async () => {
    const { service, repo, alerts, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider, collectableAgoMs: TIMEOUT_MS + HOUR });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.nearTimeout = [row];

    await service.run();

    expect(alerts.map((a) => a.dedupeKey)).toEqual([`${row.id}:past`]);
    expect(alerts[0].summary).toMatch(/has passed/);
  });
});

describe('HeldCollectionService — verification fixes', () => {
  it('tells the buyer when the refund settled an open dispute', async () => {
    const { service, repo, intents, notified, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.blockedHeld = [row];
    intents.bookBlockedProviderRefund.mockResolvedValueOnce({
      booked: true,
      disputeIds: ['dispute-1'],
    });

    await service.run();

    expect(notified).toEqual([
      expect.objectContaining({
        organizationId: row.organizationId,
        event: NotificationEvent.CALL_DISPUTE_REFUNDED,
        subjectId: 'dispute-1',
      }),
    ]);
  });

  it('a recorded cause with a suffix keeps its label', async () => {
    const { service, repo, intents, held } = setup();
    const row = heldRow(held);
    (row as { redemptionLastError: string | null }).redemptionLastError =
      'PayeeBlockedOnChain:retry';
    await held.refund(ASSET, [keyOf(row)]);
    repo.collectable = [row];

    await service.run();

    expect(intents.bookBlockedProviderRefund).toHaveBeenCalledWith(
      row.organizationId,
      row.id,
      'PayeeBlockedOnChain',
      null,
    );
  });

  it('a recorded cause whose block was lifted, still held: cleared, not refunded', async () => {
    const { service, repo, held } = setup();
    const row = heldRow(held);
    (row as { redemptionLastError: string | null }).redemptionLastError = 'ProviderBlocked';
    repo.blockedHeld = [row];

    await service.run();

    expect(held.sent).toEqual([]);
    expect(repo.cleared).toEqual([row.id]);
  });

  it('pages a backed-off row without reading the chain', async () => {
    const { service, repo, alerts, held, blocklist } = setup();
    const provider = randomUUID();
    const row = heldRow(held, { providerId: provider, collectableAgoMs: TIMEOUT_MS - 2 * HOUR });
    (row as { heldRetryAt: Date | null }).heldRetryAt = new Date(Date.now() + HOUR);
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.nearTimeout = [row];
    const read = jest.spyOn(held, 'readHeld');

    await service.run();

    expect(read).not.toHaveBeenCalled();
    expect(alerts.map((a) => a.dedupeKey)).toEqual([`${row.id}:near`]);
  });
});

describe('HeldCollectionService — gathering (COLLECT_MIN_BATCH / COLLECT_MAX_WAIT_SECONDS)', () => {
  const GATHER: GatheringPolicy = { minBatch: 20, maxWaitSeconds: 6 * 3600 };
  const collected = (held: FakeHeldPayments) =>
    held.sent.filter((s) => s.op === 'collect').flatMap((s) => s.keys);

  it('waits below both thresholds: nothing is collected', async () => {
    const { service, repo, held, intents, payments } = setup({ gathering: GATHER });
    repo.collectable = [1, 2, 3].map(() => heldRow(held, { collectableAgoMs: HOUR }));

    expect(await service.run()).toBe(0);

    expect(held.sent).toEqual([]);
    expect(intents.bookHeldCollected).not.toHaveBeenCalled();
    // Not even loaded: the count said wait (rail A's read still runs).
    const reads = (payments.findCollectable as jest.Mock).mock.calls.map((call) => call[0]);
    expect(reads).toEqual([PaymentRail.RAIL_A_PER_CALL]);
  });

  it('collects once COLLECT_MIN_BATCH are collectable, in one batch', async () => {
    const { service, repo, held } = setup({ gathering: GATHER });
    repo.collectable = Array.from({ length: 20 }, () => heldRow(held, { collectableAgoMs: HOUR }));

    expect(await service.run()).toBe(20);

    expect(held.sent.map((s) => [s.op, s.keys.length])).toEqual([['collect', 20]]);
  });

  it('collects a small batch once the oldest has waited COLLECT_MAX_WAIT_SECONDS', async () => {
    const { service, repo, held } = setup({ gathering: GATHER });
    const old = heldRow(held, { collectableAgoMs: 6 * HOUR });
    const young = heldRow(held, { collectableAgoMs: HOUR });
    repo.collectable = [old, young];

    expect(await service.run()).toBe(2);

    expect(collected(held)).toEqual([keyOf(old), keyOf(young)]);
  });

  it('still collects past-timeout records singly and refunds a blocked provider every pass', async () => {
    const { service, repo, held, blocklist } = setup({ gathering: GATHER });
    repo.collectable = [heldRow(held, { collectableAgoMs: HOUR })];
    const late = heldRow(held, { collectableAgoMs: TIMEOUT_MS + HOUR });
    repo.timedOut = [late];
    const provider = randomUUID();
    const blocked = heldRow(held, { providerId: provider });
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    repo.blockedHeld = [blocked];

    await service.run();

    expect(held.sent).toEqual([
      { op: 'refund', keys: [keyOf(blocked)] },
      { op: 'collect', keys: [keyOf(late)] },
    ]);
    expect(await statusOf(held, repo.collectable[0])).toBe(HeldStatus.HELD);
  });

  it('collects as before when the gathering check fails', async () => {
    const { service, repo, held } = setup({ gathering: GATHER });
    repo.collectable = [heldRow(held, { collectableAgoMs: HOUR })];
    repo.summaryThrows = true;

    expect(await service.run()).toBe(1);
  });

  it('a minimum batch of 1 turns gathering off', async () => {
    const { service, repo, held, payments } = setup({ gathering: NO_GATHERING });
    repo.collectable = [heldRow(held, { collectableAgoMs: HOUR })];

    expect(await service.run()).toBe(1);
    expect(
      (payments as unknown as { summarizeCollectable: jest.Mock }).summarizeCollectable,
    ).not.toHaveBeenCalled();
  });
});
